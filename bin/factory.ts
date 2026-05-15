#!/usr/bin/env bun
// arc-agents worker factory. Supervisor daemon: reaps stale tmux-claude workers,
// spawns fresh ephemeral ones when ledger has ready tasks.
//
//   `bun bin/factory.ts`           run loop in foreground
//   `bun bin/factory.ts --once`    one tick, then exit (useful for tests / cron fallback)
//   `bun bin/factory.ts --reap`    reap only, then exit
//
// Env:
//   ARC_WORKER_MAX        max concurrent workers              (default 4)
//   ARC_WORKER_MAX_AGE    seconds before reap                 (default 14400 = 4hr)
//   ARC_FACTORY_INTERVAL  loop sleep seconds                  (default 5)
//   ARC_WORKER_PREFIX     tmux session name prefix            (default "arc-worker")
//   CLAUDE_BIN            claude binary                       (default "claude")
//   ARC_LEDGER_DB         ledger path (forwarded to ledger.ts via --db)
//
// One worker = one tmux session = one claude invocation = one task.
// Session dies on completion → next tick respawns if more work exists.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SHELL = join(REPO, "bin", "worker-shell.sh");
const LEDGER = join(REPO, "bin", "ledger.ts");

const N_MAX = parseInt(process.env.ARC_WORKER_MAX ?? "4", 10);
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

export function countReady(): number {
  const r = spawnSync("bun", [LEDGER, "spawn-ready", ...DB_FLAG], { encoding: "utf8" });
  if (r.status !== 0) return 0;
  try {
    const rows = JSON.parse(r.stdout ?? "[]");
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function spawnWorker(): string {
  const name = `${PREFIX}-${shortId()}`;
  // `tmux new-session -d -s <name> <cmd>` — detached, runs cmd, session dies when cmd exits.
  // Pass worker name as arg so the shell can pass it to `ledger claim`.
  tmux(["new-session", "-d", "-s", name, "bash", SHELL, name]);
  return name;
}

export function tick(): { reaped: string[]; live: number; ready: number; spawned: string[] } {
  const reaped = reapStale();
  const live = listWorkers().length;
  const ready = countReady();
  const slots = Math.max(0, N_MAX - live);
  const toSpawn = Math.min(slots, ready);
  const spawned: string[] = [];
  for (let i = 0; i < toSpawn; i++) spawned.push(spawnWorker());
  return { reaped, live: live + spawned.length, ready, spawned };
}

async function sleep(s: number): Promise<void> {
  return new Promise((r) => setTimeout(r, s * 1000));
}

async function loop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = tick();
    if (r.reaped.length || r.spawned.length) {
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
