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
//   ARC_SLOTS_ANY         general-pool slots (any type)       (default 4)
//   ARC_SLOTS_INTERACTIVE fast-pass slots reserved for type=interactive  (default 2)
//   ARC_WORKER_MAX        legacy: if set, overrides ARC_SLOTS_ANY and disables fast-pass
//   ARC_WORKER_MAX_AGE    seconds before reap                 (default 14400 = 4hr)
//   ARC_FACTORY_INTERVAL  loop sleep seconds                  (default 5)
//   ARC_WORKER_PREFIX     tmux session name prefix            (default "arc-worker")
//   CLAUDE_BIN            claude binary                       (default "claude")
//   ARC_LEDGER_DB         ledger path (forwarded to ledger.ts via --db)
//
// Two slot pools:
//   - "any" pool serves the highest-priority ready row of any type.
//   - "interactive" pool ONLY serves type=interactive (fast-pass for work the user
//     is actively waiting on — next grill question, prefetch/precache, UX reply).
//   Interactive rows may also consume "any" slots when fast-pass is full; "any" rows
//   never consume interactive slots.
//
// One worker = one tmux session = one claude invocation = one task.
// Session dies on completion → next tick respawns if more work exists.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openWithMigrate } from "../src/ledger/db";
import { sweepStaleClaims } from "../src/ledger/claim-stale-sweeper";
import { reapWorktrees, type ReapedWorktree } from "../src/ledger/worktree-reaper";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SHELL = join(REPO, "bin", "worker-shell.sh");
const LEDGER = join(REPO, "bin", "ledger.ts");

// Legacy ARC_WORKER_MAX collapses both pools into one general bucket.
const LEGACY_MAX = process.env.ARC_WORKER_MAX ? parseInt(process.env.ARC_WORKER_MAX, 10) : null;
const SLOTS_ANY = LEGACY_MAX ?? parseInt(process.env.ARC_SLOTS_ANY ?? "4", 10);
const SLOTS_INTERACTIVE = LEGACY_MAX !== null ? 0 : parseInt(process.env.ARC_SLOTS_INTERACTIVE ?? "2", 10);
const MAX_AGE = parseInt(process.env.ARC_WORKER_MAX_AGE ?? "14400", 10);
const INTERVAL = parseInt(process.env.ARC_FACTORY_INTERVAL ?? "5", 10);
const PREFIX = process.env.ARC_WORKER_PREFIX ?? "arc-worker";
const DB_FLAG = process.env.ARC_LEDGER_DB ? ["--db", process.env.ARC_LEDGER_DB] : [];

type Session = { name: string; created: number };

function tmux(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export function listWorkers(): Session[] {
  // tmux list-sessions -F "#{session_name} #{session_created}"
  const r = tmux(["list-sessions", "-F", "#{session_name} #{session_created}"]);
  if (!r.ok) return []; // no server / no sessions
  const lines = r.out.trim().split("\n").filter(Boolean);
  const out: Session[] = [];
  for (const l of lines) {
    const [name, created] = l.split(" ");
    if (!name || !name.startsWith(`${PREFIX}-`)) continue;
    out.push({ name, created: parseInt(created ?? "0", 10) });
  }
  return out;
}

export function reapStale(now: number = Math.floor(Date.now() / 1000)): string[] {
  const reaped: string[] = [];
  for (const s of listWorkers()) {
    if (now - s.created >= MAX_AGE) {
      tmux(["kill-session", "-t", s.name]);
      reaped.push(s.name);
    }
  }
  return reaped;
}

// Tier-0 reap: kill worker sessions whose child process exited (pane_dead=1).
// Normally tmux auto-destroys a session when its last pane dies, but with
// remain-on-exit on, or with multi-pane sessions, a dead pane can linger and
// keep the slot occupied for the full MAX_AGE window. Reap immediately.
export function reapExited(): string[] {
  const r = tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_dead}"]);
  if (!r.ok) return [];
  const anyLive = new Map<string, boolean>();
  for (const l of r.out.trim().split("\n").filter(Boolean)) {
    const [name, dead] = l.split(" ");
    if (!name || !name.startsWith(`${PREFIX}-`)) continue;
    anyLive.set(name, (anyLive.get(name) ?? false) || dead !== "1");
  }
  const reaped: string[] = [];
  for (const [name, live] of anyLive) {
    if (!live) {
      tmux(["kill-session", "-t", name]);
      reaped.push(name);
    }
  }
  return reaped;
}

// Tier-1 reap: a worker whose claimed task has reached a terminal/blocked state
// is done — claude often lingers at its interactive prompt after writing the
// final turn (M-0002 mandates interactive panes, so we can't use --print). Kill
// the session so the slot frees up without waiting for MAX_AGE (tier-2 failsafe).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reapFinished(db: any): string[] {
  const sessions = listWorkers();
  if (sessions.length === 0) return [];
  const names = sessions.map((s) => s.name);
  const placeholders = names.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT claimed_by, state FROM issues WHERE claimed_by IN (${placeholders}) AND state IN ('merged','failed','cancelled','blocked')`,
    )
    .all(...names) as { claimed_by: string; state: string }[];
  const done = new Set(rows.map((r) => r.claimed_by));
  const reaped: string[] = [];
  for (const name of names) {
    if (done.has(name)) {
      tmux(["kill-session", "-t", name]);
      reaped.push(name);
    }
  }
  return reaped;
}

type ReadyRow = { id: string; kind: string; type: string; title: string };

export function listReady(typeFilter?: string): ReadyRow[] {
  const args = [LEDGER, "spawn-ready", ...DB_FLAG];
  if (typeFilter) args.push("--type", typeFilter);
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (r.status !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout ?? "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function countReady(): number {
  return listReady().length;
}

// Ready rows the factory can never claim (kind ∉ {task,event}) — e.g. `prd`
// stubs, `reply` placeholders. Operators looking at `--metrics` saw no work
// while `ledger list --state ready` showed rows; this exposes the gap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function countUnclaimableReady(db: any): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM issues WHERE state='ready' AND kind NOT IN ('task','event')`,
    )
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function spawnWorker(pool: "any" | "interactive" = "any"): string {
  // Embed pool in session name so listWorkers can re-derive pool membership without
  // a sidecar registry. `-i-` = interactive fast-pass; `-a-` = any pool.
  const infix = pool === "interactive" ? "i" : "a";
  const name = `${PREFIX}-${infix}-${shortId()}`;
  // `tmux new-session -d -s <name> <cmd>` — detached, runs cmd, session dies when cmd exits.
  // Pass worker name as arg so the shell can pass it to `ledger claim`.
  // For interactive pool, restrict the claim to type=interactive so a fast-pass slot
  // never wastes itself on a backlog task that landed in the queue first.
  const env = pool === "interactive" ? { ...process.env, ARC_CLAIM_TYPE: "interactive" } : process.env;
  spawnSync("tmux", ["new-session", "-d", "-s", name, "bash", SHELL, name], { env });
  return name;
}

export type TickResult = {
  reaped: string[];
  swept: string[];
  worktrees: ReapedWorktree[];
  live: number;
  ready: number;
  unclaimable_ready: number;
  spawned: string[];
  pools: { any: { live: number; cap: number }; interactive: { live: number; cap: number } };
};

export function tick(): TickResult {
  const reapedExited = reapExited();
  const reapedAge = reapStale();
  const db = openWithMigrate(process.env.ARC_LEDGER_DB);
  const sweep = sweepStaleClaims(db);
  const reapedDone = reapFinished(db);
  const worktrees = reapWorktrees(db);
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
    swept: sweep.ids,
    worktrees,
    live: curAny + curInteractive,
    ready: allReady.length,
    unclaimable_ready: unclaimable,
    spawned,
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
  db.close();

  return {
    alive_workers: sessions.length,
    claims_per_hr: claims?.n ?? 0,
    reaps_per_hr: reaps?.n ?? 0,
    seconds_since_last_spawn: since,
    unclaimable_ready: unclaimable,
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
  const r = spawnSync(process.execPath, [LEDGER, "doctor", "--json", ...DB_FLAG], { encoding: "utf8" });
  if (r.status !== 0) return { paths: [], branches: [] };
  try {
    const out = JSON.parse(r.stdout ?? "{}") as {
      mergeable_worktrees?: { path: string; branch: string | null }[];
    };
    const found = out.mergeable_worktrees ?? [];
    return { paths: found.map((w) => w.path), branches: found.map((w) => w.branch) };
  } catch {
    return { paths: [], branches: [] };
  }
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

async function sleep(s: number): Promise<void> {
  return new Promise((r) => setTimeout(r, s * 1000));
}

async function loop(): Promise<void> {
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
      if (r.reaped.length || r.spawned.length || r.swept.length) {
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

      const merge = auditMergeableWorktrees();
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
