#!/usr/bin/env bun
// Thin CLI driver for src/ledger/recovery-sweep.ts — wires the real probe
// (first alias-cmd candidate with a trivial prompt) into the pure module.
// Invoked by bin/recovery-sweep-tick.sh (flock'd cron). Usage: bun bin/recovery-sweep.ts [db]

import { Database } from "bun:sqlite";
import { spawnSync } from "bun";
import { sweepRecovery, type Probe } from "../src/ledger/recovery-sweep";

const DB = process.argv[2] ?? `${process.env.HOME}/vault/ledger.db`;
const REPO = new URL("..", import.meta.url).pathname;

function commandFor(alias: string): string {
  const r = spawnSync(["bun", `${REPO}bin/ledger.ts`, "alias-cmd", alias]);
  const first = new TextDecoder().decode(r.stdout).split("\n").find((l) => l.trim());
  if (r.exitCode !== 0 || !first) throw new Error(`alias-cmd failed for '${alias}'`);
  // ponytail: probe only the first candidate — one candidate alive = alias produces work
  return first.replace("{prompt}", "'reply with exactly: ok'");
}

const probe: Probe = (cmd) => {
  const r = spawnSync(["bash", "-c", cmd], { timeout: 120_000 });
  return { rc: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout) };
};

const db = new Database(DB);
const res = sweepRecovery(db, { probe, commandFor });
console.log(JSON.stringify({ ts: new Date().toISOString(), db: DB, probes: res.probes, flipped: res.flipped.length, kept: res.kept.length, skipped: res.skipped.length }));
