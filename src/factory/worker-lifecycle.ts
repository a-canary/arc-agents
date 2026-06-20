// Worker lifecycle module: spawn, reap, triage, and ready-queue reads for the
// factory. Extracted verbatim from bin/factory.ts for unit-testability and to
// keep factory.ts focused on the supervisor loop + worktree/orphan surveillance.
//
// Behavior-preserving: every function below is byte-identical to its prior home
// in bin/factory.ts. The factory remains the sole consumer; worker-shell.sh is
// the bootstrap claim (not a consumer of this module).
//
// REPO resolution note: import.meta.url is the MODULE's location. This file
// lives at src/factory/, so three dirname() hops reach the repo root — one more
// than bin/factory.ts needed (it was two hops from bin/). SHELL is computed off
// that root so spawnWorker launches the same worker-shell.sh as before.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepStaleClaims } from "../ledger/claim-stale-sweeper";
import { CLAIMABLE_KINDS_SQL, PARKED_KINDS_SQL } from "../ledger/kinds";
import { SORT_KEY_SQL } from "../ledger/tier-pool-sort";
import { runLedgerJson } from "../ledger/cli-invoke";

// src/factory/worker-lifecycle.ts → src/factory → src → <repo-root>
export const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const SHELL = join(REPO, "bin", "worker-shell.sh");

// Legacy ARC_WORKER_MAX collapses both pools into one general bucket.
const LEGACY_MAX = process.env.ARC_WORKER_MAX ? parseInt(process.env.ARC_WORKER_MAX, 10) : null;
export const SLOTS_ANY = LEGACY_MAX ?? parseInt(process.env.ARC_SLOTS_ANY ?? "4", 10);
export const SLOTS_INTERACTIVE = LEGACY_MAX !== null ? 0 : parseInt(process.env.ARC_SLOTS_INTERACTIVE ?? "2", 10);
export const MAX_AGE = parseInt(process.env.ARC_WORKER_MAX_AGE ?? "14400", 10);
export const PREFIX = process.env.ARC_WORKER_PREFIX ?? "arc-worker";

export type Session = { name: string; created: number };
export type ReadyRow = { id: string; kind: string; type: string; title: string };

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

// Tier-0.5 reap: reclaim orphan claims whose worker tmux session no longer exists.
// Gap this fills: a worker holds a fresh claim, then its tmux session disappears
// outside the reap path (OOM kill, manual kill -9, host reboot). pane_dead never
// fires (session is fully gone), age sweep won't catch it (claim < 2hr old), and
// reapFinished only matches terminal states. Without this, the row sits orphaned
// for up to 2hr, blocking dependents.
//
// Guarded by PREFIX so we never touch claims from other factories sharing the
// ledger (e.g. arc-worker vs arctest-* runs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reapOrphanClaims(db: any): string[] {
  const live = new Set(listWorkers().map((s) => s.name));
  const rows = db
    .query(
      `SELECT id, claimed_by FROM issues WHERE state='claimed' AND claimed_by LIKE ?`,
    )
    .all(`${PREFIX}-%`) as { id: string; claimed_by: string }[];
  const orphaned = rows.filter((r) => !live.has(r.claimed_by));
  if (orphaned.length === 0) return [];
  const ids: string[] = [];
  db.transaction(() => {
    for (const r of orphaned) {
      db.run(
        `UPDATE issues SET state='ready', claimed_by=NULL, claimed_at=NULL, updated_at=strftime('%s','now') WHERE id=?`,
        [r.id],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'reclaimed', 'claim-stale-sweeper', ?)`,
        [r.id, `orphan claim reset (claimed_by=${r.claimed_by}, tmux session gone)`],
      );
      ids.push(r.id);
    }
  })();
  return ids;
}

// triageUnset: fill pool/agent sentinels (*_unset) on ready rows so they become
// dispatchable. Pure-SQL, no LLM, no worker. Runs each tick after orphan/stale reap.
//
// Rules (only applied to columns still at their *_unset sentinel):
//   agent: arc-chat source_module → 'chat'; kind=prd → 'director'; else → 'developer'
//   pool:  tier in (mvp,trust,prod) → 'build'; else → 'explore'
//   tier:  NEVER changed (tier_unset rows sink to bottom of queue; that is intentional)
//
// Env:
//   ARC_TRIAGE_BUDGET  max rows per call (default 10)
//   ARC_TRIAGE_DISABLE set to "1" to skip entirely
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function triageUnset(
  db: any,
  budget: number = Number(process.env.ARC_TRIAGE_BUDGET ?? "10"),
): string[] {
  if (process.env.ARC_TRIAGE_DISABLE === "1") return [];

  // Select up to budget ready rows that still have at least one *_unset sentinel.
  const rows = db
    .query(
      `SELECT id, kind, tier, pool, agent, source_module
       FROM issues
       WHERE state='ready' AND (agent='agent_unset' OR pool='pool_unset')
       ORDER BY ${SORT_KEY_SQL}
       LIMIT ?`,
    )
    .all(budget) as { id: string; kind: string; tier: string; pool: string; agent: string; source_module: string | null }[];

  if (rows.length === 0) return [];

  const triaged: string[] = [];
  db.transaction(() => {
    for (const row of rows) {
      // Compute new agent (only if still sentinel)
      let newAgent: string | null = null;
      if (row.agent === "agent_unset") {
        if (row.source_module === "arc-chat") {
          newAgent = "chat";
        } else if (row.kind === "prd") {
          newAgent = "director";
        } else {
          newAgent = "developer"; // catch-all: task, event, reply, etc.
        }
      }

      // Compute new pool (only if still sentinel)
      let newPool: string | null = null;
      if (row.pool === "pool_unset") {
        if (row.tier === "mvp" || row.tier === "trust" || row.tier === "prod") {
          newPool = "build";
        } else {
          newPool = "explore"; // hygiene, quality, efficiency, scale, tier_unset
        }
      }

      // Build SET clause — only touch columns that actually need updating
      const setParts: string[] = ["updated_at=strftime('%s','now')"];
      const params: unknown[] = [];
      if (newAgent !== null) { setParts.push("agent=?"); params.push(newAgent); }
      if (newPool !== null) { setParts.push("pool=?"); params.push(newPool); }
      params.push(row.id);

      db.run(`UPDATE issues SET ${setParts.join(", ")} WHERE id=?`, params);

      const desc = [
        newAgent ? `agent=${newAgent}` : null,
        newPool ? `pool=${newPool}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'triaged', 'triage', ?)`,
        [row.id, `triage: ${desc}`],
      );
      triaged.push(row.id);
    }
  })();

  return triaged;
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

export function listReady(poolFilter?: string): ReadyRow[] {
  const args: string[] = [];
  if (poolFilter) args.push("--pool", poolFilter);
  const rows = runLedgerJson<ReadyRow[]>("spawn-ready", args, []);
  return Array.isArray(rows) ? rows : [];
}

export function countReady(): number {
  return listReady().length;
}

// Ready rows the factory can never claim — surfaces transient artifacts the
// factory ignores (`reply`, `prefetch`) so operators can spot stuck queues.
// PARKED_KINDS (e.g. PRDs) are excluded by design: parked indefinitely for
// human reference, not stuck work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function countUnclaimableReady(db: any): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM issues WHERE state='ready' AND kind NOT IN (${CLAIMABLE_KINDS_SQL}) AND kind NOT IN (${PARKED_KINDS_SQL})`,
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
  // For interactive pool, restrict the claim to pool=interactive so a fast-pass slot
  // never wastes itself on a backlog task that landed in the queue first.
  // ARC_CLAIM_POOL is the preferred env var; ARC_CLAIM_TYPE is kept for one transition
  // window so in-flight worker-shell instances still work either way.
  const env = pool === "interactive"
    ? { ...process.env, ARC_CLAIM_POOL: "interactive", ARC_CLAIM_TYPE: "interactive" }
    : process.env;
  spawnSync("tmux", ["new-session", "-d", "-s", name, "bash", SHELL, name], { env });
  return name;
}

// Re-export so factory.ts can consume sweepStaleClaims through this module's
// surface without a second import path (it sits in the same lifecycle layer).
export { sweepStaleClaims };
