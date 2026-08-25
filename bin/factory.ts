#!/usr/bin/env bun
// arc-agents worker factory. Supervisor daemon: reaps stale tmux-claude workers,
// spawns fresh ephemeral ones when ledger has ready tasks.
//
//   `bun bin/factory.ts`           run loop in foreground
//   `bun bin/factory.ts --once`    one tick, then exit (useful for tests / cron fallback)
//   `bun bin/factory.ts --reap`    reap only, then exit
//   `bun bin/factory.ts --metrics` print observability snapshot, then exit
//
// Env:
//   ARC_SLOTS_ANY         general-pool slots (any pool)       (default 4)
//   ARC_SLOTS_INTERACTIVE fast-pass slots reserved for pool=interactive  (default 2)
//   ARC_WORKER_MAX        legacy: if set, overrides ARC_SLOTS_ANY and disables fast-pass
//   ARC_WORKER_MAX_AGE    seconds before reap                 (default 14400 = 4hr)
//   ARC_FACTORY_INTERVAL  loop sleep seconds                  (default 5)
//   ARC_WORKER_PREFIX     tmux session name prefix            (default "arc-worker")
//   CLAUDE_BIN            claude binary                       (default "claude")
//   ARC_LEDGER_DB         ledger path (forwarded to ledger.ts via --db)
//   ARC_TRIAGE_BUDGET     max rows triaged per tick           (default 10)
//   ARC_TRIAGE_DISABLE    set to "1" to skip triageUnset     (default unset)
//
// Two slot pools:
//   - "any" pool serves the highest-priority ready row of any pool.
//   - "interactive" pool ONLY serves pool=interactive (fast-pass for work the user
//     is actively waiting on — next grill question, prefetch/precache, UX reply).
//   Interactive rows may also consume "any" slots when fast-pass is full; "any" rows
//   never consume interactive slots.
//
// One worker = one tmux session = one claude invocation = one task.
// Session dies on completion → next tick respawns if more work exists.
//
// Worker spawn/reap/triage/ready-queue primitives are extracted into
// src/factory/worker-lifecycle.ts for unit-testability. This file owns the
// supervisor loop, worktree/orphan surveillance, observability, and the CLI.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import {
  reapWorktrees,
  backstopPurgeWorktrees,
  sweepTmpFixtures,
  type ReapedWorktree,
  type BackstopResult,
  type TmpFixtureResult,
} from "../src/ledger/worktree-reaper";
import { runLedgerJson } from "../src/ledger/cli-invoke";
import {
  REPO,
  SLOTS_ANY,
  SLOTS_INTERACTIVE,
  MAX_AGE,
  PREFIX,
  listWorkers,
  reapStale,
  reapExited,
  reapOrphanClaims,
  triageUnset,
  reapFinished,
  listReady,
  countUnclaimableReady,
  spawnWorker,
  sweepStaleClaims,
} from "../src/factory/worker-lifecycle";
import { sweepCrossRepoGate, type CrossRepoParked } from "../src/ledger/cross-repo-gate";
// Re-export for back-compat: factory-triage.test.ts dynamic-imports
// `triageUnset` (and `reapFinished`) off bin/factory.ts.
export { triageUnset, reapFinished };

const INTERVAL = parseInt(process.env.ARC_FACTORY_INTERVAL ?? "5", 10);

// Trigger (c): 7-day backstop disk-scan over the worktrees root. It's expensive
// (readdir + a couple of `git rev-list` per dir), so we don't run it every 5s
// tick — gate it to BACKSTOP_INTERVAL (default 30min). ARC_WORKTREES_ROOT
// defaults to ~/worktrees (where worker-shell.sh isolates each worker).
const WORKTREES_ROOT =
  process.env.ARC_WORKTREES_ROOT ?? join(process.env.HOME ?? "", "worktrees");
const BACKSTOP_MAX_AGE = parseInt(process.env.ARC_BACKSTOP_MAX_AGE ?? `${7 * 86400}`, 10);
const BACKSTOP_INTERVAL = parseInt(process.env.ARC_BACKSTOP_INTERVAL ?? "1800", 10);
const BACKSTOP_DISABLE = process.env.ARC_BACKSTOP_DISABLE === "1";
// Trigger (d): abandoned test fixtures under $TMPDIR. Rides the same interval
// gate as (c) — a hung/SIGKILLed test run leaks its /tmp scratch dir plus any
// worktree registered into it (2026-08-20: 52 dirs, ~51 prunable worktrees).
const TMPDIR_ROOT = process.env.TMPDIR ?? "/tmp";
const TMP_FIXTURE_MAX_AGE = parseInt(process.env.ARC_TMP_FIXTURE_MAX_AGE ?? `${6 * 3600}`, 10);
let lastBackstop = 0;

export type TickResult = {
  reaped: string[];
  swept: string[];
  worktrees: ReapedWorktree[];
  backstop: BackstopResult[];
  tmp_fixtures: TmpFixtureResult[];
  sweeper_cooldown_excluded: { orphan: string[]; stale: string[] };
  live: number;
  ready: number;
  unclaimable_ready: number;
  spawned: string[];
  triaged: string[];
  cross_repo_parked: CrossRepoParked[];
  pools: { any: { live: number; cap: number }; interactive: { live: number; cap: number } };
};

export function tick(): TickResult {
  const reapedExited = reapExited();
  const reapedAge = reapStale();
  const db = openWithMigrate(process.env.ARC_LEDGER_DB);
  const orphanResult = reapOrphanClaims(db);
  const orphans = orphanResult.ids;
  const sweep = sweepStaleClaims(db);
  const reapedDone = reapFinished(db);
  const sweeperCooldownExcluded = {
    orphan: orphanResult.cooldownExcluded,
    stale: sweep.cooldownExcluded,
  };
  const worktrees = reapWorktrees(db);
  // (c) 7-day backstop: periodic disk-scan for orphan worktrees with no live row.
  // Interval-gated so the readdir + per-dir git calls don't run every 5s tick.
  const nowSec = Math.floor(Date.now() / 1000);
  let backstop: BackstopResult[] = [];
  let tmpFixtures: TmpFixtureResult[] = [];
  if (!BACKSTOP_DISABLE && nowSec - lastBackstop >= BACKSTOP_INTERVAL) {
    lastBackstop = nowSec;
    backstop = backstopPurgeWorktrees(db, {
      worktreesRoot: WORKTREES_ROOT,
      parentRepo: REPO,
      maxAgeSec: BACKSTOP_MAX_AGE,
      now: nowSec,
    });
    tmpFixtures = sweepTmpFixtures({
      tmpRoot: TMPDIR_ROOT,
      parentRepo: REPO,
      maxAgeSec: TMP_FIXTURE_MAX_AGE,
      now: nowSec,
    });
  }
  const triaged = triageUnset(db);
  // KE Pattern A gate: park mis-routed ready rows (text targets another
  // repo) hitl=1 BEFORE the claim path sees them; gate-triage adjudicates.
  const crossRepoParked = sweepCrossRepoGate(db);
  const unclaimable = countUnclaimableReady(db);
  db.close();
  const reaped = [...reapedExited, ...reapedAge, ...reapedDone];

  // tmux sessions don't carry pool identity — track via prefix suffix `-i-` / `-a-`.
  // Legacy sessions (no infix) count as "any".
  const sessions = listWorkers();
  const liveInteractive = sessions.filter((s) => s.name.startsWith(`${PREFIX}-i-`)).length;
  const liveAny = sessions.length - liveInteractive;

  const interactiveReady = listReady("interactive");
  const allReady = listReady();
  // Non-interactive ready rows: take from allReady, subtract interactive.
  const interactiveIds = new Set(interactiveReady.map((r) => r.id));
  const nonInteractiveReady = allReady.filter((r) => !interactiveIds.has(r.id));

  const spawned: string[] = [];
  let curInteractive = liveInteractive;
  let curAny = liveAny;

  // Phase 1: fill fast-pass slots with interactive work.
  let iIdx = 0;
  while (curInteractive < SLOTS_INTERACTIVE && iIdx < interactiveReady.length) {
    spawned.push(spawnWorker("interactive"));
    curInteractive++;
    iIdx++;
  }

  // Phase 2: fill general slots — interactive overflow first (still highest priority),
  // then non-interactive in priority order.
  while (curAny < SLOTS_ANY && iIdx < interactiveReady.length) {
    spawned.push(spawnWorker("any"));
    curAny++;
    iIdx++;
  }
  let nIdx = 0;
  while (curAny < SLOTS_ANY && nIdx < nonInteractiveReady.length) {
    spawned.push(spawnWorker("any"));
    curAny++;
    nIdx++;
  }

  return {
    reaped,
    swept: [...orphans, ...sweep.ids],
    worktrees,
    backstop,
    tmp_fixtures: tmpFixtures,
    sweeper_cooldown_excluded: sweeperCooldownExcluded,
    live: curAny + curInteractive,
    ready: allReady.length,
    unclaimable_ready: unclaimable,
    spawned,
    triaged,
    cross_repo_parked: crossRepoParked,
    pools: {
      any: { live: curAny, cap: SLOTS_ANY },
      interactive: { live: curInteractive, cap: SLOTS_INTERACTIVE },
    },
  };
}

export type Metrics = {
  alive_workers: number;
  claims_per_hr: number;
  reaps_per_hr: number;
  seconds_since_last_spawn: number | null;
  unclaimable_ready: number;
  sweeper_cooldown_excluded: { count: number; ids: string[] };
  slots: { any: { live: number; cap: number }; interactive: { live: number; cap: number } };
};

export function metrics(now: number = Math.floor(Date.now() / 1000)): Metrics {
  const sessions = listWorkers();
  const liveInteractive = sessions.filter((s) => s.name.startsWith(`${PREFIX}-i-`)).length;
  const liveAny = sessions.length - liveInteractive;
  const lastSpawn = sessions.reduce((m, s) => Math.max(m, s.created), 0);
  const since = lastSpawn === 0 ? null : Math.max(0, now - lastSpawn);

  const db = openWithMigrate(process.env.ARC_LEDGER_DB);
  const hourAgo = now - 3600;
  const claims = db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM issue_events WHERE kind='claimed' AND ts >= ?`,
    )
    .get(hourAgo);
  // Event kind must match what claim-stale-sweeper actually writes
  // (src/ledger/claim-stale-sweeper.ts inserts kind='reclaimed'). Was 'note'
  // here, so reaps_per_hr silently always reported 0.
  const reaps = db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM issue_events WHERE kind='reclaimed' AND agent='claim-stale-sweeper' AND ts >= ?`,
    )
    .get(hourAgo);
  const unclaimable = countUnclaimableReady(db);
  // Cooldown-excluded rows: distinct issue_ids with a kind='note' audit event
  // from claim-stale-sweeper in the trailing window. The note is emitted once
  // per window per row (not per skip), so this counts distinct runaways — not
  // the raw skip rate.
  const cooldownRows = db
    .query<{ issue_id: string }, [number]>(
      `SELECT DISTINCT issue_id FROM issue_events
        WHERE kind='note' AND agent='claim-stale-sweeper'
          AND payload_md LIKE 'sweeper cooldown:%' AND ts >= ?`,
    )
    .all(hourAgo);
  db.close();

  return {
    alive_workers: sessions.length,
    claims_per_hr: claims?.n ?? 0,
    reaps_per_hr: reaps?.n ?? 0,
    seconds_since_last_spawn: since,
    unclaimable_ready: unclaimable,
    sweeper_cooldown_excluded: { count: cooldownRows.length, ids: cooldownRows.map((r) => r.issue_id) },
    slots: {
      any: { live: liveAny, cap: SLOTS_ANY },
      interactive: { live: liveInteractive, cap: SLOTS_INTERACTIVE },
    },
  };
}

// Detect orphaned wait-for-ledger.ts procs older than 24hr.
// Context: wait-for-ledger.ts used to accept --role; it was renamed to --kind,
// but stale launch sites kept spawning the old flag — the binary printed usage
// to stderr in a tight loop while the parent held the pid. Three such procs
// ran for 5+ days unnoticed (2026-05-15 → 2026-05-20).
// Pure: returns findings; never logs, never kills.
export function auditOrphans(): { pids: number[]; ages: number[] } {
  const r = spawnSync("ps", ["-eo", "pid=,etimes=,cmd="], { encoding: "utf8" });
  if (r.status !== 0) return { pids: [], ages: [] };
  const pids: number[] = [];
  const ages: number[] = [];
  for (const raw of (r.stdout ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes("wait-for-ledger.ts")) continue;
    if (line.includes("grep ")) continue;
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    const etimes = parseInt(m[2]!, 10);
    if (pid === process.pid) continue;
    if (etimes < 86400) continue; // <24hr — fresh, not orphan
    pids.push(pid);
    ages.push(etimes);
  }
  return { pids, ages };
}

export function printOrphanWarn(found: { pids: number[]; ages: number[] }, now: number = Math.floor(Date.now() / 1000)): void {
  console.error(
    JSON.stringify({
      ts: new Date(now * 1000).toISOString(),
      warn: "orphaned_wait_for_ledger",
      count: found.pids.length,
      pids: found.pids,
      ages_hr: found.ages.map((a) => +(a / 3600).toFixed(1)),
      hint: "ps -fp <pid> to inspect; kill <pid> if confirmed stale",
    }),
  );
}

export function printOrphansCleared(priorCount: number, now: number = Math.floor(Date.now() / 1000)): void {
  console.log(
    JSON.stringify({
      ts: new Date(now * 1000).toISOString(),
      info: "orphans_cleared",
      prior_count: priorCount,
    }),
  );
}

// Detect registered worktrees whose HEAD is an ancestor of main (== fully merged,
// safe to remove). `ledger doctor` already surfaces these but only when run on
// demand; the daemon owns continuous surveillance, so emit the same alert with
// edge+heartbeat throttling. Pure: returns findings; never removes anything
// (auto-removal is a separate, riskier decision left for a future iteration).
//
// Scoped to ~/worktrees/<prefix>* via the existing `ledger doctor --json` reader
// to reuse its battle-tested git porcelain parsing rather than re-implementing.
export function auditMergeableWorktrees(): { paths: string[]; branches: (string | null)[] } {
  type DoctorOut = { mergeable_worktrees?: { path: string; branch: string | null }[] };
  const out = runLedgerJson<DoctorOut>("doctor", ["--json"], {});
  const found = out.mergeable_worktrees ?? [];
  return { paths: found.map((w) => w.path), branches: found.map((w) => w.branch) };
}

export function printMergeableWarn(
  found: { paths: string[]; branches: (string | null)[] },
  now: number = Math.floor(Date.now() / 1000),
): void {
  console.error(
    JSON.stringify({
      ts: new Date(now * 1000).toISOString(),
      warn: "mergeable_worktrees",
      count: found.paths.length,
      paths: found.paths,
      branches: found.branches,
      hint: "branch fully merged to main; `git worktree remove <path>` to reclaim disk",
    }),
  );
}

export function printMergeableCleared(priorCount: number, now: number = Math.floor(Date.now() / 1000)): void {
  console.log(
    JSON.stringify({
      ts: new Date(now * 1000).toISOString(),
      info: "mergeable_cleared",
      prior_count: priorCount,
    }),
  );
}

// Opt-in auto-prune for mergeable worktrees. Closes the loop between detect
// (auditMergeableWorktrees) and act, so the standing warn becomes a self-
// healing reap. Gated behind ARC_AUTO_PRUNE=1 because the worktrees this
// targets are user-owned scratch (no claude-agent lock) — different blast
// radius from the ledger-row worktree-reaper which only touches rows with
// state='merged'.
//
// SAFETY:
//   - Only proceeds if `git status --porcelain` is empty per worktree.
//     Uncommitted changes => skip (warn still fires next tick).
//   - Uses plain `git worktree remove` (no `-f -f`). If git refuses for any
//     reason, we skip and log.
//   - Branch delete is best-effort after worktree removal.
//   - Scope is limited to whatever auditMergeableWorktrees() already returned
//     (which comes from `ledger doctor`, which only surfaces HEAD-is-ancestor-
//     of-main worktrees). No new discovery surface added here.
export type PruneResult = {
  pruned: { path: string; branch: string | null }[];
  skipped: { path: string; branch: string | null; reason: string }[];
};

export function reapMergeableWorktrees(
  found: { paths: string[]; branches: (string | null)[] } = auditMergeableWorktrees(),
): PruneResult {
  const result: PruneResult = { pruned: [], skipped: [] };
  if (process.env.ARC_AUTO_PRUNE !== "1") return result;
  for (let i = 0; i < found.paths.length; i++) {
    const path = found.paths[i]!;
    const branch = found.branches[i] ?? null;

    // Safety: must be a clean working tree.
    const dirty = spawnSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" });
    if (dirty.status !== 0) {
      result.skipped.push({ path, branch, reason: "git-status-failed" });
      continue;
    }
    if ((dirty.stdout ?? "").trim() !== "") {
      result.skipped.push({ path, branch, reason: "dirty-worktree" });
      continue;
    }

    // Resolve parent repo (the dir that owns the worktree registry).
    const common = spawnSync("git", ["-C", path, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
    if (common.status !== 0) {
      result.skipped.push({ path, branch, reason: "no-common-dir" });
      continue;
    }
    const real = spawnSync("realpath", [(common.stdout ?? "").trim()], { encoding: "utf8", cwd: path });
    if (real.status !== 0) {
      result.skipped.push({ path, branch, reason: "realpath-failed" });
      continue;
    }
    const absCommon = (real.stdout ?? "").trim();
    const parent = absCommon.endsWith("/.git") ? absCommon.slice(0, -5) : absCommon;

    const rm = spawnSync("git", ["-C", parent, "worktree", "remove", path], { encoding: "utf8" });
    if (rm.status !== 0) {
      result.skipped.push({ path, branch, reason: `remove-failed: ${(rm.stderr ?? "").trim().slice(0, 200)}` });
      continue;
    }

    // Best-effort branch delete. -d (not -D) so we still refuse to nuke a
    // branch that isn't actually merged. mergeable-worktrees already filtered
    // for HEAD-is-ancestor-of-main, so this should normally succeed.
    if (branch) spawnSync("git", ["-C", parent, "branch", "-d", branch], { encoding: "utf8" });

    result.pruned.push({ path, branch });
  }
  return result;
}

export function printMergeablePruned(
  result: PruneResult,
  now: number = Math.floor(Date.now() / 1000),
): void {
  if (result.pruned.length === 0 && result.skipped.length === 0) return;
  console.log(
    JSON.stringify({
      ts: new Date(now * 1000).toISOString(),
      info: "mergeable_pruned",
      pruned_count: result.pruned.length,
      skipped_count: result.skipped.length,
      pruned: result.pruned,
      skipped: result.skipped,
    }),
  );
}

async function sleep(s: number): Promise<void> {
  return new Promise((r) => setTimeout(r, s * 1000));
}

// One-shot startup line. Lets operators correlate post-restart silence with an
// actual fresh daemon (vs. a hung old one). Emitted only by `loop()` — short
// modes (--once / --reap / --metrics) stay quiet so they remain pipe-friendly.
export function printFactoryStarted(
  cfg: {
    slots_any: number;
    slots_interactive: number;
    max_age_sec: number;
    interval_sec: number;
    prefix: string;
    db: string | null;
  },
  now: number = Math.floor(Date.now() / 1000),
): void {
  console.log(
    JSON.stringify({
      ts: new Date(now * 1000).toISOString(),
      info: "factory_started",
      pid: process.pid,
      ...cfg,
    }),
  );
}

async function loop(): Promise<void> {
  printFactoryStarted({
    slots_any: SLOTS_ANY,
    slots_interactive: SLOTS_INTERACTIVE,
    max_age_sec: MAX_AGE,
    interval_sec: INTERVAL,
    prefix: PREFIX,
    db: process.env.ARC_LEDGER_DB ?? null,
  });
  // Throttle "unclaimable_ready > 0" stuck-queue warnings: emit on the 0→N edge
  // and re-emit every 5 min while stuck, so operators see the gap without spam
  // on every quiet tick. Same shape applies to orphan-wait-for-ledger detection.
  let lastUnclaimable = 0;
  let lastUnclaimableLog = 0;
  let lastOrphans = 0;
  let lastOrphansLog = 0;
  let lastMergeable = 0;
  let lastMergeableLog = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = tick();
      const backstopRemoved = r.backstop.filter((b) => b.outcome === "removed").length;
      if (r.reaped.length || r.spawned.length || r.swept.length || backstopRemoved || r.cross_repo_parked.length) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), ...r }));
      }
      const now = Math.floor(Date.now() / 1000);
      const edge = r.unclaimable_ready > 0 && lastUnclaimable === 0;
      const heartbeat = r.unclaimable_ready > 0 && now - lastUnclaimableLog >= 300;
      if (edge || heartbeat) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          warn: "unclaimable_ready",
          count: r.unclaimable_ready,
          hint: "kind ∉ {task,event} — factory cannot claim; check `ledger list --state ready`",
        }));
        lastUnclaimableLog = now;
      }
      lastUnclaimable = r.unclaimable_ready;

      const orph = auditOrphans();
      const orphEdge = orph.pids.length > 0 && lastOrphans === 0;
      const orphHeartbeat = orph.pids.length > 0 && now - lastOrphansLog >= 300;
      if (orphEdge || orphHeartbeat) {
        printOrphanWarn(orph, now);
        lastOrphansLog = now;
      }
      if (orph.pids.length === 0 && lastOrphans > 0) {
        printOrphansCleared(lastOrphans, now);
      }
      lastOrphans = orph.pids.length;

      let merge = auditMergeableWorktrees();
      // If auto-prune enabled, act before warning — successful prunes shouldn't
      // also produce a stuck-state warn. Re-audit only if anything was pruned
      // (so the warn reflects post-prune leftovers, not pre-prune state).
      const prune = reapMergeableWorktrees(merge);
      if (prune.pruned.length > 0 || prune.skipped.length > 0) {
        printMergeablePruned(prune, now);
      }
      if (prune.pruned.length > 0) merge = auditMergeableWorktrees();
      const mergeEdge = merge.paths.length > 0 && lastMergeable === 0;
      const mergeHeartbeat = merge.paths.length > 0 && now - lastMergeableLog >= 300;
      if (mergeEdge || mergeHeartbeat) {
        printMergeableWarn(merge, now);
        lastMergeableLog = now;
      }
      if (merge.paths.length === 0 && lastMergeable > 0) {
        printMergeableCleared(lastMergeable, now);
      }
      lastMergeable = merge.paths.length;
    } catch (err) {
      // Don't let a single bad tick (silent tmux/ledger error) kill the daemon
      // and freeze the queue. Log + continue. See bug: factory went silent on
      // 2026-05-15T23:23 with no log line despite Ssl process state.
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error(JSON.stringify({ ts: new Date().toISOString(), tick_error: msg }));
    }
    await sleep(INTERVAL);
  }
}

async function run(): Promise<void> {
  if (process.argv.includes("--reap")) {
    const reaped = reapStale();
    console.log(JSON.stringify({ reaped }));
    return;
  }
  if (process.argv.includes("--metrics")) {
    console.log(JSON.stringify(metrics()));
    return;
  }
  if (process.argv.includes("--once")) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...tick() }));
    return;
  }
  await loop();
}

if (import.meta.main) run();
