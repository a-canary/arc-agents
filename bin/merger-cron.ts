#!/usr/bin/env bun
// merger-cron — daily cron wrapper around `bin/merger-sweep.ts`.
//
// Spec: ledger row `wire-merger-sweep-ts-into-daily-cron-wit`.
// Doctrine: per `g-0010-or-i-0008-cap-per-pr-hitl-emissio`, NEVER emit one
// HITL per PR. Aggregate all `hitl_*` actions from merger-sweep into ONE
// cluster prompt ("you have N PRs needing human triage"). Skip-not-stack:
// if yesterday's cluster prompt is still open, today's tick is a no-op.
//
// Install (operator's crontab, daily at 09:07 local):
//   7 9 * * *  cd /home/aaron/repos/arc-agents && bun bin/merger-cron.ts >> ~/vault/log/merger-cron.log 2>&1
//
// Output (stdout, one JSON object): one of
//   {"skipped": true, "reason": "prior cluster HITL still open", "hitl_id": "..."}
//   {"ready": N, "hitl": M, "hitl_id": "..." | null, "defer": K, "skip": L}
//
// Exit codes: 0 ok (incl. skipped), 1 merger-sweep failed, 2 hitl emit failed.
//
// The `ready` partition is logged only — the merger subagent is not yet
// invoked from a cron context (deferred slice).

import { spawnSync } from "node:child_process";
import { open } from "../src/ledger/db";

type SweepLine = { pr: number; action: string; reason: string };

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SWEEP_BIN = `${REPO_ROOT}/bin/merger-sweep.ts`;
const LEDGER_BIN = `${REPO_ROOT}/bin/ledger.ts`;
const EMITTED_BY = "merger-cron";
const TIMEOUT_SEC = 86400; // 24h — taste class requires --timeout-sec
const CLUSTER_RECOMMENDED = "defer-all";

// Test seam: tests substitute a fake sweep binary by setting these envs.
const SWEEP_OVERRIDE = process.env.ARC_MERGER_SWEEP_BIN;
const BUN_BIN = process.env.ARC_BUN_BIN ?? "bun";

function hasOpenClusterHitl(): { id: string } | null {
  const db = open();
  try {
    const row = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM hitl_prompts
         WHERE state='open' AND emitted_by=?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(EMITTED_BY);
    return row ?? null;
  } finally {
    db.close();
  }
}

function runSweep(): SweepLine[] {
  const argv = SWEEP_OVERRIDE
    ? [SWEEP_OVERRIDE, "--dry-run"]
    : [BUN_BIN, SWEEP_BIN, "--dry-run"];
  const res = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(`merger-cron: merger-sweep failed (status=${res.status}): ${res.stderr ?? ""}\n`);
    process.exit(1);
  }
  const out = (res.stdout ?? "").trim();
  if (out.length === 0) return [];
  const lines: SweepLine[] = [];
  for (const ln of out.split("\n")) {
    const s = ln.trim();
    if (s.length === 0) continue;
    try {
      lines.push(JSON.parse(s) as SweepLine);
    } catch (e) {
      process.stderr.write(`merger-cron: bad sweep line: ${s}\n`);
      process.exit(1);
    }
  }
  return lines;
}

function buildClusterPrompt(hitl: SweepLine[]): string {
  const header = `merger-sweep flagged ${hitl.length} PR${hitl.length === 1 ? "" : "s"} needing human triage:`;
  const body = hitl
    .map((l) => `  #${l.pr} [${l.action}] ${l.reason}`)
    .join("\n");
  const tail =
    `\n\nChoose: 'defer-all' to dismiss until tomorrow's sweep; 'resolve-now' to address them now ` +
    `(opens individual reviews via the merger subagent).`;
  return `${header}\n${body}${tail}`;
}

function emitClusterHitl(hitl: SweepLine[]): string {
  const prompt = buildClusterPrompt(hitl);
  const argv = [
    BUN_BIN,
    LEDGER_BIN,
    "hitl",
    "emit",
    "--class",
    "taste",
    "--kind",
    "ask_choice",
    "--prompt",
    prompt,
    "--option",
    "defer-all",
    "--option",
    "resolve-now",
    "--recommended",
    CLUSTER_RECOMMENDED,
    "--timeout-sec",
    String(TIMEOUT_SEC),
    "--emitted-by",
    EMITTED_BY,
    "--agent",
    EMITTED_BY,
  ];
  const res = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(
      `merger-cron: hitl emit failed (status=${res.status}): ${res.stderr ?? ""}\n`,
    );
    process.exit(2);
  }
  // ledger hitl emit prints `{"id":"...", ...}` JSON on stdout; tolerate trailing text.
  const out = (res.stdout ?? "").trim();
  try {
    const parsed = JSON.parse(out);
    if (typeof parsed?.id === "string") return parsed.id;
  } catch {
    // fall through to a fuzzy match
  }
  const m = out.match(/"id"\s*:\s*"([^"]+)"/);
  return m?.[1] ?? "";
}

const existing = hasOpenClusterHitl();
if (existing) {
  process.stdout.write(
    JSON.stringify({ skipped: true, reason: "prior cluster HITL still open", hitl_id: existing.id }) + "\n",
  );
  process.exit(0);
}

const lines = runSweep();
const buckets = { ready: [] as SweepLine[], hitl: [] as SweepLine[], defer: [] as SweepLine[], skip: [] as SweepLine[] };
for (const l of lines) {
  if (l.action === "ready") buckets.ready.push(l);
  else if (l.action.startsWith("hitl_")) buckets.hitl.push(l);
  else if (l.action === "defer") buckets.defer.push(l);
  else buckets.skip.push(l);
}

// `ready` is logged-only in this slice — merger subagent invocation is deferred.
for (const r of buckets.ready) {
  process.stderr.write(`merger-cron: ready #${r.pr} ${r.reason}\n`);
}

let hitlId: string | null = null;
if (buckets.hitl.length > 0) {
  hitlId = emitClusterHitl(buckets.hitl);
}

process.stdout.write(
  JSON.stringify({
    ready: buckets.ready.length,
    hitl: buckets.hitl.length,
    hitl_id: hitlId,
    defer: buckets.defer.length,
    skip: buckets.skip.length,
  }) + "\n",
);
