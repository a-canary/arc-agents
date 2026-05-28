#!/usr/bin/env bun
// Factory demo — runnable from a clean clone.
// Requires: bun (bun.sh), tmux, claude CLI in PATH.
//
// This starts the supervisor daemon that:
//   - Scans the ledger for ready tasks
//   - Spawns ephemeral tmux workers to claim and execute them
//   - Reaps stale workers (>4hr old)
//
// No private paths, no proprietary keys.
// Override ledger DB with ARC_LEDGER_DB env var.
//
// Slot limits (env overrides, shown defaults):
//   ARC_SLOTS_ANY=4          general pool slots
//   ARC_SLOTS_INTERACTIVE=2   fast-pass slots for pool=interactive
//   ARC_WORKER_MAX_AGE=14400 seconds before reap (default 4hr)
//
// Usage:
//   examples/run-factory.ts            normal foreground run (Ctrl+C to stop)
//   examples/run-factory.ts --once      one tick, print summary, exit
//   examples/run-factory.ts --metrics  print current worker snapshot, exit
//   examples/run-factory.ts --reap      reap stale workers, exit

const args = process.argv.slice(2);
const isOnce = args.includes("--once");
const isMetrics = args.includes("--metrics");
const isReap = args.includes("--reap");

console.error("arc-agents factory demo");
console.error("Ledger DB:", process.env.ARC_LEDGER_DB ?? "~/vault/ledger.db (default)");

if (isReap) {
  const db = (await import("../src/ledger/db")).openWithMigrate();
  const { sweepStaleClaims } = await import("../src/ledger/claim-stale-sweeper");
  const { reapWorktrees } = await import("../src/ledger/worktree-reaper");
  const db2 = (await import("../src/ledger/db")).openWithMigrate();
  const s = sweepStaleClaims(db);
  const r = reapWorktrees(db2);
  console.log(JSON.stringify({ stale_swept: s, worktrees_reaped: r }, null, 2));
  process.exit(0);
}

if (isMetrics) {
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  const sessions = out.status === 0 ? out.stdout.trim().split("\n").filter(Boolean) : [];
  console.log(JSON.stringify({ tmux_sessions: sessions, count: sessions.length }, null, 2));
  process.exit(0);
}

// For --once and foreground modes, delegate directly to the real factory binary.
const REPO = (await import("node:path")).join((await import("node:url")).fileURLToPath((await import("node:url")).import.meta.url), "..", "..");
const FACTORY_BIN = (await import("node:path")).join(REPO, "bin", "factory.ts");

if (isOnce) {
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env };
  const r = spawnSync("bun", [FACTORY_BIN, "--once"], { env, encoding: "utf8" });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.status ?? 0);
}

console.error("");
console.error("Starting factory daemon...");
console.error("(Interrupt with Ctrl+C to stop)");
const { factory } = await import(FACTORY_BIN);
await factory();