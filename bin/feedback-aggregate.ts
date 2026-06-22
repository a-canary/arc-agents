#!/usr/bin/env bun
// feedback-aggregate.ts — turn captured end-user feedback into a single Proposal
// (ADR-0010 planning, ADR-0012 system-change regime). Reads the state='new'
// feedback rows for a project, frames them as one development request, and spawns
// the L6 Planning Agent (plan-agent.ts) to mint a PRD(state=review) + tracer tasks
// parked at the human approval gate. On success, links the aggregated rows to the
// PRD (theme_id) and flips them state='resolved' so they are not re-aggregated.
//
//   feedback-aggregate.ts [--project P] [--limit N]
//
// PRODUCES proposals only — never spawns implementation workers, merges, or
// deploys (the planner it calls has the same contract). Like plan-agent.ts it
// degrades gracefully: if the planner returns no PRD id (model timeout/
// contention), the feedback rows are left 'new' for the next run, so nothing is
// dropped — the human approval gate keeps any weak draft harmless.
//
// ponytail: aggregates by project only. Weighting feedback by trust tier is the
// gated L1 domain decision (source==trust-tier vs channel, fb-qupj) — add once
// that vocabulary is unified; until then every 'new' row counts equally.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";

export type FeedbackRow = { id: string; body_md: string; source: string };
type DB = ReturnType<typeof openWithMigrate>;

/** Frame a batch of feedback rows as one development request. The Planning Agent
 *  does the actual decomposition; this only presents the raw feedback and asks
 *  for a single coherent change addressing the strongest themes. */
export function buildAggregateRequest(project: string, rows: FeedbackRow[]): string {
  const bullets = rows.map((r) => `- (${r.source || "anon"}) ${r.body_md.trim()}`).join("\n");
  return [
    `The following ${rows.length} pieces of end-user feedback were submitted for the ${project} project:`,
    "",
    bullets,
    "",
    "Propose a single coherent change that addresses the highest-impact themes across this feedback.",
    "Group related items; if items conflict, pick the strongest theme rather than trying to satisfy all.",
  ].join("\n");
}

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

/** Fetch up to `limit` unaggregated ('new') feedback rows for a project, oldest first. */
export function selectNewFeedback(db: DB, project: string, limit: number): FeedbackRow[] {
  return db
    .query<FeedbackRow, [string, number]>(
      "SELECT id, body_md, source FROM feedback WHERE state='new' AND project=? ORDER BY created_at ASC LIMIT ?",
    )
    .all(project, limit);
}

/** Link a batch of feedback rows to the PRD they produced and mark them resolved. */
export function markAggregated(db: DB, ids: string[], themeId: string): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  db.run(`UPDATE feedback SET state='resolved', theme_id=? WHERE id IN (${ph})`, [themeId, ...ids]);
}

/** Run the Planning Agent on `request`; return its minted PRD id, or null on failure. */
function runPlanner(request: string, project: string): string | null {
  const planAgent = join(import.meta.dir, "plan-agent.ts");
  const r = spawnSync(process.execPath, [planAgent, "--request", request, "--project", project], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const last = r.stdout.trim().split("\n").pop() ?? "";
    const out = JSON.parse(last) as { prdId?: unknown };
    return typeof out.prdId === "string" && out.prdId ? out.prdId : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const project = getFlag(argv, "project") ?? "arc-webui";
  const limit = Number(getFlag(argv, "limit") ?? "20") || 20;

  const db = openWithMigrate();
  const rows = selectNewFeedback(db, project, limit);
  if (rows.length === 0) {
    process.stdout.write(JSON.stringify({ aggregated: 0, prdId: null }) + "\n");
    return;
  }

  const prdId = runPlanner(buildAggregateRequest(project, rows), project);
  if (!prdId) {
    process.stderr.write("feedback-aggregate: planner produced no PRD; leaving feedback 'new' for next run\n");
    process.exit(1);
  }
  markAggregated(db, rows.map((r) => r.id), prdId);
  process.stdout.write(JSON.stringify({ aggregated: rows.length, prdId }) + "\n");
}

if (import.meta.main) { await main(); }
