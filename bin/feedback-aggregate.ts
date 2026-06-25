#!/usr/bin/env bun
// feedback-aggregate.ts — turn captured end-user feedback into Proposals via a two-tier
// CAM (ADR-0010 planning, ADR-0012 system-change regime). An LLM Collector groups the
// state='new' feedback rows for a project into thematic categories (label/pattern/ids);
// the Proposal Generator then drafts ONE Proposal per CONFIRMED category by spawning the
// L6 Planning Agent (plan-agent.ts) to mint a PRD(state=review) + tracer tasks parked at
// the human approval gate. On success, links that category's rows to the PRD (theme_id)
// and flips them state='resolved'; un-confirmed/uncategorised rows stay 'new'.
//
// CONFIRMATION GATE: a Proposal is only drafted when a CATEGORY is corroborated —
// 1 trusted voice OR 3 distinct untrusted submitters (confirmsProposal, applied per
// category). Below the threshold the planner is never spawned and that category's
// feedback stays 'new' for a future run. Trust tier is binary (isTrusted); see fb-qupj.
//
//   feedback-aggregate.ts [--project P] [--limit N]
//
// PRODUCES proposals only — never spawns implementation workers, merges, or
// deploys (the planner it calls has the same contract). Like plan-agent.ts it
// degrades gracefully: if the planner returns no PRD id (model timeout/
// contention), the feedback rows are left 'new' for the next run, so nothing is
// dropped — the human approval gate keeps any weak draft harmless.
//
// ponytail: the Collector is one no-tools MiniMax call and degrades to a single
// 'general' category on failure (the old batch-level behaviour). Per-category counts/
// patterns are emitted for /feed + /approvals transparency; wiring that UI is the next
// slice. Trust tier (fb-qupj) is resolved — source channel maps to binary trust.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";

export type FeedbackRow = { id: string; body_md: string; source: string; submitter?: string | null };
type DB = ReturnType<typeof openWithMigrate>;

/** A thematic group the LLM Collector extracted from the batch: a label, a one-line
 *  shared pattern, and the feedback ids it covers. */
export type Category = { label: string; pattern: string; ids: string[] };
/** A Category enriched with its row count + confirmation gate (the per-category gate). */
export type CategorySummary = {
  label: string;
  pattern: string;
  count: number;
  rows: FeedbackRow[];
  gate: ReturnType<typeof confirmsProposal>;
};

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

// --- The LLM Collector (CAM collector tier: reads wide, recall-bounded, cheap model) ---
// Words-only JSON shape; no literal template/fence (a code fence makes headless MiniMax
// loop to timeout — same finding as plan-agent).
export function buildCollectorPrompt(project: string, rows: FeedbackRow[]): string {
  const bullets = rows.map((r) => `- [${r.id}] (${r.source || "anon"}) ${r.body_md.trim()}`).join("\n");
  return [
    `You are a feedback collector for the ${project} project. Group the user feedback below into a few thematic categories.`,
    "",
    bullets,
    "",
    "Output a single JSON object and nothing else — no prose, no code fences. Use exactly this shape:",
    "- categories: an array of objects, each with three keys",
    "  - label: a short category name, a string under 60 characters",
    "  - pattern: one sentence describing the shared pattern across that category's feedback",
    "  - ids: an array of the bracketed [fb-..] feedback id strings above that belong to this category",
    "Assign every id to exactly one category. Prefer a few strong categories over many thin ones.",
  ].join("\n");
}

// Defensive parse (mirrors plan-agent parsePlanJson): the model may wrap the object in
// prose or a fence. Strip a fence, take the outermost braces, validate. Hallucinated ids
// are dropped against the real batch; categories left with no real id are dropped; null
// if nothing valid survives so the caller falls back to a single 'general' category.
export function parseCategoriesJson(stdout: string, rows: FeedbackRow[]): Category[] | null {
  if (!stdout) return null;
  let s = stdout.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + 1);
  let obj: { categories?: unknown };
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || !Array.isArray(obj.categories)) return null;
  const valid = new Set(rows.map((r) => r.id));
  const cats: Category[] = [];
  for (const c of obj.categories) {
    if (!c || typeof c !== "object") continue;
    const o = c as { label?: unknown; pattern?: unknown; ids?: unknown };
    if (typeof o.label !== "string" || !o.label.trim()) continue;
    if (!Array.isArray(o.ids)) continue;
    const ids = o.ids.filter((id): id is string => typeof id === "string" && valid.has(id));
    if (ids.length === 0) continue;
    cats.push({ label: o.label.trim(), pattern: typeof o.pattern === "string" ? o.pattern.trim() : "", ids });
  }
  return cats.length > 0 ? cats : null;
}

// One no-tools MiniMax call groups the batch (same shape as plan-agent.generatePlan).
// On any failure it degrades to a single 'general' category so the batch still reaches
// the per-category gate — never a dropped request.
function collectCategories(project: string, rows: FeedbackRow[]): Category[] {
  const pi = Bun.which("pi") ?? "pi";
  const r = spawnSync(
    pi,
    ["-p", "--no-tools", "--provider", "minimax", "--model", "MiniMax-M3", "--thinking", "high", buildCollectorPrompt(project, rows)],
    { encoding: "utf8", timeout: 120_000 },
  );
  const parsed = r.status === 0 && r.stdout ? parseCategoriesJson(r.stdout, rows) : null;
  return parsed ?? [{ label: "general", pattern: "all feedback (collector unavailable)", ids: rows.map((x) => x.id) }];
}

// Attach a count + the confirmation gate to each category. The Proposal Generator only
// drafts for summaries whose gate.confirmed is true (the per-category gate).
export function summarizeCategories(rows: FeedbackRow[], categories: Category[]): CategorySummary[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return categories.map((c) => {
    const catRows = c.ids.map((id) => byId.get(id)).filter((r): r is FeedbackRow => !!r);
    return { label: c.label, pattern: c.pattern, count: catRows.length, rows: catRows, gate: confirmsProposal(catRows) };
  });
}

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

/** Fetch up to `limit` unprocessed feedback rows for a project, oldest first.
 *  Tolerates both 'new' (the live table's DEFAULT — agent-CLI rows are born 'new')
 *  and 'OPEN' (webui's normalized value), like arc-webui's own reads. Querying 'OPEN'
 *  alone would skip every freshly-submitted agent row until webui happened to touch it. */
export function selectNewFeedback(db: DB, project: string, limit: number): FeedbackRow[] {
  return db
    .query<FeedbackRow, [string, number]>(
      "SELECT id, body_md, source, submitter FROM feedback WHERE state IN ('new','OPEN') AND project=? ORDER BY created_at ASC LIMIT ?",
    )
    .all(project, limit);
}

/** Link a batch of feedback rows to the PRD they produced and move them to DEV — a PRD
 *  now exists, so they leave the OPEN triage queue (webui owns the later DEV→CLOSED). */
export function markAggregated(db: DB, ids: string[], themeId: string): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  db.run(`UPDATE feedback SET state='DEV', theme_id=? WHERE id IN (${ph})`, [themeId, ...ids]);
}

/** The trigger gate (the requested run condition). A scheduled tick spends LLM effort
 *  only when the OPEN backlog earns a planner: ≥1 trusted voice (the operator spoke —
 *  act now) OR >5 untrusted rows (enough end-user/agent signal piled up). */
export function triggerGate(rows: FeedbackRow[]): { fire: boolean; trusted: number; untrusted: number } {
  const trusted = rows.filter((r) => isTrusted(r.source)).length;
  const untrusted = rows.length - trusted;
  return { fire: trusted >= 1 || untrusted > 5, trusted, untrusted };
}

/** Projects with at least one unprocessed feedback row — the tick's work-list for
 *  --all-projects. Same 'new'/'OPEN' tolerance as selectNewFeedback (live rows born 'new'). */
export function projectsWithOpenFeedback(db: DB): string[] {
  return db
    .query<{ project: string }, []>("SELECT DISTINCT project FROM feedback WHERE state IN ('new','OPEN')")
    .all()
    .map((r) => r.project);
}

/** A category enriched with its gate + the PRD it drafted (or null). The shape main()
 *  emits and recordCollection persists. */
export type CollectedCategory = {
  label: string;
  pattern: string;
  count: number;
  confirmed: boolean;
  trusted: number;
  untrusted: number;
  prdId: string | null;
};

/** Append one collector run's categories to the feedback_theme ledger (CAM audit,
 *  keyed project x round) — including un-confirmed ones — so the portal can surface
 *  counts/patterns regardless of the gate. */
export function recordCollection(db: DB, project: string, roundId: string, cats: CollectedCategory[]): void {
  for (const c of cats) {
    db.run(
      "INSERT INTO feedback_theme (round_id, project, label, pattern, count, confirmed, trusted, untrusted, prd_id) VALUES (?,?,?,?,?,?,?,?,?)",
      [roundId, project, c.label, c.pattern, c.count, c.confirmed ? 1 : 0, c.trusted, c.untrusted, c.prdId],
    );
  }
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
  const limit = Number(getFlag(argv, "limit") ?? "20") || 20;
  const db = openWithMigrate();

  const projects = argv.includes("--all-projects")
    ? projectsWithOpenFeedback(db)
    : [getFlag(argv, "project") ?? "arc-webui"];

  const runs = projects.map((project) => aggregateProject(db, project, limit));
  process.stdout.write(JSON.stringify(runs.length === 1 ? runs[0] : { runs }) + "\n");
}

/** Aggregate one project's OPEN feedback into at most one planner pass. The trigger
 *  gate decides whether to spend the LLM at all; below the gate it's a cheap no-op. */
export function aggregateProject(db: DB, project: string, limit: number): Record<string, unknown> {
  const rows = selectNewFeedback(db, project, limit);
  const gate = triggerGate(rows);
  if (!gate.fire) {
    return { project, aggregated: 0, skipped: "gate", trusted: gate.trusted, untrusted: gate.untrusted };
  }

  // CAM: the Collector reads wide and groups the batch; the Proposal Generator gates
  // EACH category. Below-threshold categories (and any feedback the collector left
  // uncategorised) stay OPEN for a future run — nothing is dropped. Every category's
  // counts/patterns/gate are surfaced in the output regardless of the gate, for
  // transparency to /feed and /approvals.
  const summaries = summarizeCategories(rows, collectCategories(project, rows));

  const roundId = "fbr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  let aggregated = 0;
  const categories: CollectedCategory[] = summaries.map((sm) => {
    let prdId: string | null = null;
    if (sm.gate.confirmed) {
      prdId = runPlanner(buildAggregateRequest(project, sm.rows), project);
      if (prdId) {
        markAggregated(db, sm.rows.map((r) => r.id), prdId);
        aggregated += sm.rows.length;
      }
    }
    return { label: sm.label, pattern: sm.pattern, count: sm.count, ...sm.gate, prdId };
  });

  recordCollection(db, project, roundId, categories);
  return { project, aggregated, roundId, categories };
}

if (import.meta.main) { await main(); }
