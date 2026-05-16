#!/usr/bin/env bun
// arc-agents worker factory. Supervisor daemon: reaps stale tmux-claude workers,
// spawns fresh ephemeral ones when ledger has ready tasks.
//
//   `bun bin/factory.ts`           run loop in foreground
//   `bun bin/factory.ts --once`    one tick, then exit (useful for tests / cron fallback)
//   `bun bin/factory.ts --reap`    reap only, then exit
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

type ReadyRow = { id: string; kind: string; type: string; title: string };

export function listReady(typeFilter?: string): ReadyRow[] {
  const args = [LEDGER, "spawn-ready", ...DB_FLAG];
  if (typeFilter) args.push("--type", typeFilter);
  const r = spawnSync("bun", args, { encoding: "utf8" });
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
  live: number;
  ready: number;
  spawned: string[];
  pools: { any: { live: number; cap: number }; interactive: { live: number; cap: number } };
};

export function tick(): TickResult {
  const reaped = reapStale();
  const db = openWithMigrate(process.env.ARC_LEDGER_DB);
  const sweep = sweepStaleClaims(db);
  db.close();

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
    live: curAny + curInteractive,
    ready: allReady.length,
    spawned,
    pools: {
      any: { live: curAny, cap: SLOTS_ANY },
      interactive: { live: curInteractive, cap: SLOTS_INTERACTIVE },
    },
  };
}

async function sleep(s: number): Promise<void> {
  return new Promise((r) => setTimeout(r, s * 1000));
}

async function loop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = tick();
    if (r.reaped.length || r.spawned.length || r.swept.length) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...r }));
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
  if (process.argv.includes("--once")) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...tick() }));
    return;
  }
  await loop();
}

if (import.meta.main) run();
