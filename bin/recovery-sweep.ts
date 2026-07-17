#!/usr/bin/env bun
// Thin CLI driver for src/ledger/recovery-sweep.ts — wires the real probe
// (first alias-cmd candidate with a trivial prompt) into the pure module.
// Invoked by bin/recovery-sweep-tick.sh (flock'd cron). Usage: bun bin/recovery-sweep.ts [db]

import { Database } from "bun:sqlite";
import { spawnSync } from "bun";
import { existsSync } from "node:fs";
import { sweepRecovery, sweepMergedPrDesync, type Probe, type SalvageHandoff, type SalvageInspection, type PrStateRunner } from "../src/ledger/recovery-sweep";

const DB = process.argv[2] ?? `${process.env.HOME}/vault/ledger.db`;
const REPO = new URL("..", import.meta.url).pathname;

export function commandFor(alias: string): string {
  const r = spawnSync(["bun", `${REPO}bin/ledger.ts`, "alias-cmd", alias]);
  const first = new TextDecoder().decode(r.stdout).split("\n").find((l) => l.trim());
  if (r.exitCode !== 0 || !first) throw new Error(`alias-cmd failed for '${alias}'`);
  // ponytail: probe only the first candidate — one candidate alive = alias produces work
  return first.replace("{prompt}", "'reply with exactly: ok'");
}

export const probe: Probe = (cmd) => {
  const r = spawnSync(["bash", "-c", cmd], { timeout: 120_000 });
  return { rc: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout) };
};

function inspectSalvage(h: SalvageHandoff): SalvageInspection {
  const worktree = h.worktreePath;
  if (!worktree || !existsSync(worktree)) return { branchExists: false, headMatches: false, commitsMatch: false, prState: null };
  const git = (...args: string[]) => spawnSync(["git", "-C", worktree, ...args]);
  const head = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();
  const commits = Number(new TextDecoder().decode(git("rev-list", "--count", `${h.base}..${h.head}`).stdout).trim());
  let prState: SalvageInspection["prState"] = null;
  if (h.prUrl) {
    const pr = spawnSync(["gh", "pr", "view", h.prUrl, "--json", "state", "--jq", ".state"]);
    if (pr.exitCode === 0) {
      const state = new TextDecoder().decode(pr.stdout).trim();
      if (state === "OPEN" || state === "MERGED" || state === "CLOSED") prState = state;
    }
  }
  return { branchExists: true, headMatches: head === h.head, commitsMatch: commits === h.commits, prState };
}

export const prState: PrStateRunner = (prUrl) => {
  const r = spawnSync(["gh", "pr", "view", prUrl, "--json", "state", "--jq", ".state"]);
  if (r.exitCode !== 0) return null;
  const state = new TextDecoder().decode(r.stdout).trim();
  return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
};

export function runRecoverySweep(db: Database, sweepProbe = probe) {
  return sweepRecovery(db, { probe: sweepProbe, commandFor, inspectSalvage });
}

if (import.meta.main) {
  const db = new Database(DB);
  const res = runRecoverySweep(db);
  const desyncs = sweepMergedPrDesync(db, prState);
  console.log(JSON.stringify({ ts: new Date().toISOString(), db: DB, probes: res.probes, flipped: res.flipped.length, kept: res.kept.length, skipped: res.skipped.length, salvage: res.salvage, merged_pr_desyncs: desyncs }));
}
