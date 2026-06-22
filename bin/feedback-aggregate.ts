#!/usr/bin/env bun
// feedback-aggregate.ts — turn captured end-user feedback into a single Proposal
// (ADR-0010 planning, ADR-0012 system-change regime). Reads the state='new'
// feedback rows for a project, frames them as one development request, and spawns
// the L6 Planning Agent (plan-agent.ts) to mint a PRD(state=review) + tracer tasks
// parked at the human approval gate. On success, links the aggregated rows to the
// PRD (theme_id) and flips them state='resolved' so they are not re-aggregated.
//
// CONFIRMATION GATE: a Proposal is only drafted when the batch is corroborated —
// 1 trusted voice OR 3 distinct untrusted submitters (confirmsProposal). Below the
// threshold, the planner is never spawned and the feedback stays 'new' for a future
// run. Trust tier is binary (isTrusted); see fb-qupj resolution below.
//
//   feedback-aggregate.ts [--project P] [--limit N]
//
// PRODUCES proposals only — never spawns implementation workers, merges, or
// deploys (the planner it calls has the same contract). Like plan-agent.ts it
// degrades gracefully: if the planner returns no PRD id (model timeout/
// contention), the feedback rows are left 'new' for the next run, so nothing is
// dropped — the human approval gate keeps any weak draft harmless.
//
// ponytail: aggregates the whole project batch as one theme. The next slice is the
// LLM Collector that splits the batch into categories and applies confirmsProposal
// PER category; until then the gate is batch-level. Trust tier (fb-qupj) is resolved
// for the gate — source channel maps to a binary trusted/untrusted (isTrusted).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";

export type FeedbackRow = { id: string; body_md: string; source: string; submitter?: string | null };
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

// Trust tier (fb-qupj resolved 2026-06-22). The portal writes feedback CHANNELS, but
// the confirmation gate needs a binary trust tier. Operator channels are trusted —
// the :8080 portal is Aaron-only over tailscale, so `direct` IS the operator; mission/
// operator are explicit. Everyone else (public, github, ai-agent, anon) is untrusted.
const TRUSTED_SOURCES = new Set(["direct", "mission", "operator"]);
export function isTrusted(source: string): boolean {
  return TRUSTED_SOURCES.has(source);
}

// The Proposal Generator only drafts when a theme is corroborated: 1 trusted voice,
// or 3 DISTINCT untrusted submitters. Distinct-by-submitter stops one untrusted voice
// spamming N rows to fake confirmation.
// ponytail: a null submitter counts as its own distinct source so anonymous public
// feedback can still corroborate; the anti-spam ceiling is rate-limiting at intake,
// not here (3 anonymous rows could be one person — tighten at the /feedback boundary).
export function confirmsProposal(rows: FeedbackRow[]): {
  confirmed: boolean;
  trusted: number;
  untrusted: number;
} {
  const trusted = rows.filter((r) => isTrusted(r.source)).length;
  const voices = new Set(
    rows
      .filter((r) => !isTrusted(r.source))
      .map((r) => (r.submitter && r.submitter.trim()) || `id:${r.id}`),
  );
  const untrusted = voices.size;
  return { confirmed: trusted >= 1 || untrusted >= 3, trusted, untrusted };
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
      "SELECT id, body_md, source, submitter FROM feedback WHERE state='new' AND project=? ORDER BY created_at ASC LIMIT ?",
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

  const gate = confirmsProposal(rows);
  if (!gate.confirmed) {
    // Below the confirmation threshold — surface the counts, leave feedback 'new'
    // for a future run once more corroboration (or a trusted voice) arrives.
    process.stdout.write(
      JSON.stringify({ aggregated: 0, prdId: null, reason: "below confirmation threshold", ...gate }) + "\n",
    );
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
