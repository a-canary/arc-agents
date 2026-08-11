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
//   feedback-aggregate.ts [--project P] [--limit N] [--validate-stale]
//
// Two-pass stale/superseded flow (this slice):
//   1. flagStaleFeedback — runs by default; flags rows whose theme_id points to a
//      merged PRD (state=merged, updated_at > feedback.created_at).
//   2. validateStaleCandidates — opt-in via --validate-stale; re-verifies the PRD
//      is still merged and resolves the feedback (state=resolved, resolution=
//      'superseded') or rejects (clears tentative columns, leaves state='new').
//      Scheduled to run on a separate cadence (not every collector tick) so freshly
//      flagged rows aren't immediately verified against themselves.
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

export type FeedbackRow = {
  id: string;
  body_md: string;
  source: string;
  submitter?: string | null;
  // ponytail: webui-side stamping of mode/author_trust lands in the arc-webui repo;
  // here we only READ author_trust (null = legacy unstamped row → channel fallback).
  author_trust?: string | null;
};
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
//
// IMPORTANT (drain vs trust): being `direct`/trusted does NOT mean drain-eligible.
// Machine log rows (auto-oversight, future watchdog) sit in the same channel table but
// are excluded at SELECT by MACHINE_LOG_SOURCES below — exclusion happens BEFORE trust
// is ever evaluated. Touching trust semantics? Touch MACHINE_LOG_SOURCES in the same
// edit so the carve-out stays in sync.
const TRUSTED_SOURCES = new Set(["direct", "mission", "operator"]);

// Machine-log sources are NEVER drained as user feedback — they are display-only audit
// logs (the allmissions oversight pane, future watchdog reports). Excluded at SELECT
// (not at trust evaluation), so an oversight-only backlog is invisible to both the
// row-fetch and the project-sweep: the */5 tick's --all-projects drain won't even
// queue it, the trigger gate can't fire, and rows stay OPEN indefinitely. Adding a
// future machine log writer is a one-line append. See PR #318 (sibling slice, same
// exclusion applied to the Lane-2 drain).
export const MACHINE_LOG_SOURCES = new Set(["auto-oversight", "gate-triage"]);

// Trust keys on the EXPLICIT author_trust column first (closing the source='direct'
// degeneracy: arc-webui stamps every row 'direct', so a single product user looked like
// the operator and minted a PRD). 'operator' ⇒ trusted; 'product' ⇒ NOT trusted even on
// a 'direct' channel. Only when author_trust is null/undefined (legacy unstamped rows,
// pre-migration 025) do we fall back to the channel logic, preserving prior behavior.
export function isTrusted(source: string, author_trust?: string | null): boolean {
  if (author_trust === "operator") return true;
  if (author_trust === "product") return false;
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
  const trusted = rows.filter((r) => isTrusted(r.source, r.author_trust)).length;
  const voices = new Set(
    rows
      .filter((r) => !isTrusted(r.source, r.author_trust))
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

/** Bare boolean flag — getFlag can't detect these (returns argv[i+1], undefined when last). */
export function hasFlag(argv: string[], name: string): boolean {
  return argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

/** Fetch up to `limit` unaggregated feedback rows for a project, oldest first.
 *  Tolerates 'OPEN' as well as 'new': agent-CLI rows are born 'new', but arc-webui
 *  normalizes them to 'OPEN' on read, so the live backlog is mostly 'OPEN'. A
 *  'new'-only query would silently skip every webui-touched row.
 *
 *  Also excludes rows with non-null `declined_at` — the don't-re-propose cooldown
 *  marker (migration 027, set by markDeclined when PR #18's approval gate dismisses
 *  a Proposal). The marker is the truth: a row is skipped regardless of its state
 *  column. PR #285's Validator (resolution='superseded') achieves the same
 *  observable effect via state='resolved'. */
// Build the machine-log exclusion predicate for SQL. Currently a single source, but
// the set keeps the door open for future machine writers (a watchdog cron, a sync job)
// without a schema change. The empty-set case is collapsed to "1=1" so the predicate
// stays a no-op if the set ever drains.
function machineLogNotInSql(): string {
  if (MACHINE_LOG_SOURCES.size === 0) return "1=1";
  const quoted = Array.from(MACHINE_LOG_SOURCES).map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  return `source NOT IN (${quoted})`;
}

export function selectNewFeedback(db: DB, project: string, limit: number): FeedbackRow[] {
  return db
    .query<FeedbackRow, [string, number]>(
      `SELECT id, body_md, source, submitter, author_trust FROM feedback WHERE state IN ('new','OPEN') AND declined_at IS NULL AND ${machineLogNotInSql()} AND project=? ORDER BY created_at ASC LIMIT ?`,
    )
    .all(project, limit);
}

/** Cheap project-level pre-gate: is this project's backlog worth a planner-spending
 *  aggregation pass yet? Fires on >=1 trusted row OR >5 untrusted rows (raw count, the
 *  scheduler's coarse trigger — confirmsProposal still gates each PRD per-category by
 *  distinct submitter). Below the bar the pass is skipped and rows stay queued, so the
 *  scheduled tick is a no-op on thin backlogs. */
export function triggerGate(rows: FeedbackRow[]): { fire: boolean; trusted: number; untrusted: number } {
  const trusted = rows.filter((r) => isTrusted(r.source, r.author_trust)).length;
  const untrusted = rows.length - trusted;
  return { fire: trusted >= 1 || untrusted > 5, trusted, untrusted };
}

/** Every project with at least one unaggregated feedback row (drives --all-projects).
 *  Machine-log sources are excluded: a project whose backlog is ONLY machine logs
 *  doesn't appear here, so the drain never queues it and the trigger gate never
 *  fires — a no-op tick, not a wasted planner call. */
export function projectsWithOpenFeedback(db: DB): string[] {
  return db
    .query<{ project: string }, []>(
      `SELECT DISTINCT project FROM feedback WHERE state IN ('new','OPEN') AND ${machineLogNotInSql()} ORDER BY project`,
    )
    .all()
    .map((r) => r.project);
}

/** Link a batch of feedback rows to the PRD they produced and mark them resolved. */
export function markAggregated(db: DB, ids: string[], themeId: string): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  db.run(`UPDATE feedback SET state='resolved', theme_id=? WHERE id IN (${ph})`, [themeId, ...ids]);
}

/** Dismiss verdict: flip state to 'resolved' AND stamp `declined_at = now()`. PR #18
 *  (arc-webui) wires this from the Proposal-approval gate's "no" button. Exporting
 *  it from the arc-agents feedback module keeps the SQL primitive in one place —
 *  both writers (arc-webui's dismiss handler and future arc-agents callers) hit the
 *  same shape. No-op on an empty id list. The `declined_at` column (migration 027)
 *  is the authoritative don't-re-propose marker; selectNewFeedback skips any row
 *  where it is set, regardless of state. */
export function markDeclined(db: DB, ids: string[]): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  db.run(
    `UPDATE feedback SET state='resolved', declined_at=CAST(strftime('%s','now') AS INTEGER) WHERE id IN (${ph})`,
    ids,
  );
}

// --- 2-pass stale/superseded (collector flag + validator accept/reject) ---
// Pass 1 tentatively flags feedback rows whose theme_id points to a PRD merged
// AFTER the feedback was created — the work shipped elsewhere, so the feedback
// is stale. Pass 2 re-verifies the PRD is genuinely merged (not cancelled/failed
// and not deleted) and either resolves the feedback with resolution='superseded'
// or clears the tentative verdict and leaves it 'new' for a future run.
//
// ponytail: validation in pass 2 is just "is the row still merged" — there's no
// body-similarity scoring against the PRD. The feedback's theme_id already
// expresses the link; the validator's job is to catch stale links where the
// PRD was reverted after pass 1 flagged it.

/** Pass 1: flag new-state feedback whose theme_id is a merged PRD created later.
 *  Writes stale_candidate_at + stale_candidate_prd_id; returns the number flagged. */
export function flagStaleFeedback(db: DB, project: string): number {
  const r = db
    .query<{ id: string }, [string]>(
      `SELECT f.id FROM feedback f
         JOIN issues p ON p.id = f.theme_id
        WHERE f.project = ?
          AND f.state = 'new'
          AND f.theme_id IS NOT NULL
          AND f.stale_candidate_at IS NULL
          AND p.kind = 'prd'
          AND p.state = 'merged'
          AND p.updated_at > f.created_at`,
    )
    .all(project);
  if (r.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const ph = r.map(() => "?").join(",");
  db.run(
    `UPDATE feedback SET stale_candidate_at=?, stale_candidate_prd_id=theme_id WHERE id IN (${ph})`,
    [now, ...r.map((x) => x.id)],
  );
  return r.length;
}

/** Pass 2 outcome. accepted = superseded; rejected = tentative verdict cleared,
 *  feedback stays 'new'. */
export type ValidateResult = { accepted: number; rejected: number };

/** Pass 2: re-verify tentative flags. Accepted (PRD still merged) -> state=resolved
 *  + resolution='superseded'. Rejected (PRD cancelled/failed/missing) -> clear the
 *  tentative columns, leave state='new'. */
export function validateStaleCandidates(db: DB, project: string): ValidateResult {
  const rows = db
    .query<
      { id: string; stale_candidate_prd_id: string | null },
      [string]
    >(
      `SELECT id, stale_candidate_prd_id FROM feedback
        WHERE project = ?
          AND state = 'new'
          AND stale_candidate_at IS NOT NULL
          AND stale_candidate_prd_id IS NOT NULL`,
    )
    .all(project);
  let accepted = 0;
  let rejected = 0;
  for (const row of rows) {
    const prd = row.stale_candidate_prd_id!;
    const stillMerged = db
      .query<{ ok: number }, [string]>("SELECT 1 AS ok FROM issues WHERE id=? AND kind='prd' AND state='merged'")
      .get(prd);
    if (stillMerged) {
      db.run("UPDATE feedback SET state='resolved', resolution='superseded' WHERE id=?", [row.id]);
      accepted++;
    } else {
      db.run(
        "UPDATE feedback SET stale_candidate_at=NULL, stale_candidate_prd_id=NULL WHERE id=?",
        [row.id],
      );
      rejected++;
    }
  }
  return { accepted, rejected };
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

type ProjectResult = {
  project: string;
  aggregated: number;
  flagged: number;
  validated: ValidateResult | null;
  trigger: ReturnType<typeof triggerGate>;
  roundId?: string;
  skipped?: string;
  categories: CollectedCategory[];
};

/** Run one project's full pass: flag-stale -> (optional validate) -> trigger-gate ->
 *  collect -> per-category plan. The trigger gate is the cheap pre-filter; below it we
 *  spend no Collector/planner call and leave rows queued for a future tick. */
function aggregateProject(db: DB, project: string, limit: number, validate: boolean): ProjectResult {
  // Pass 1: flag stale (feedback linked to a PRD that merged later). Runs FIRST so the
  // collector below only sees rows that weren't superseded.
  const flagged = flagStaleFeedback(db, project);

  // Pass 2 (opt-in --validate-stale): re-verify tentative flags and resolve. Default
  // runs leave it to a separate cadence so freshly flagged rows aren't verified against
  // themselves.
  const validated: ValidateResult | null = validate ? validateStaleCandidates(db, project) : null;

  const rows = selectNewFeedback(db, project, limit);
  const trigger = triggerGate(rows);
  if (rows.length === 0 || !trigger.fire) {
    return {
      project, aggregated: 0, flagged, validated, trigger,
      skipped: rows.length === 0 ? "empty" : "gate", categories: [],
    };
  }

  // Cooldown: if the last collector round for this project was <60 min ago and minted
  // no PRD, the same OPEN rows would just re-categorize to the same no-op (observed
  // 2026-08-04: OneNation's 11 gated rows burned an LLM collector run every 5-min tick).
  // Round timestamp is encoded in round_id ("fbr-<base36 ms>-<rand>").
  const lastRound = db
    .query<{ round_id: string; minted: number }, [string]>(
      "SELECT round_id, MAX(prd_id IS NOT NULL) AS minted FROM feedback_theme WHERE project=? GROUP BY round_id ORDER BY round_id DESC LIMIT 1",
    )
    .get(project);
  if (lastRound && !lastRound.minted) {
    const lastMs = parseInt(lastRound.round_id.split("-")[1] ?? "", 36);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < 60 * 60 * 1000) {
      return { project, aggregated: 0, flagged, validated, trigger, skipped: "cooldown", categories: [] };
    }
    // Unchanged OPEN row-set re-categorizes to the same no-op every hour (observed
    // 2026-08-10: OneNation's 14 gated rows burned 24 collector runs/day). Skip until
    // the set grows. ponytail: keyed on row count only — an edited-in-place row won't
    // re-trigger; upgrade to a content hash if that ever matters.
    const lastTotal = db
      .query<{ n: number }, [string]>("SELECT COALESCE(SUM(count),0) AS n FROM feedback_theme WHERE round_id=?")
      .get(lastRound.round_id);
    if (lastTotal && rows.length === lastTotal.n) {
      return { project, aggregated: 0, flagged, validated, trigger, skipped: "cooldown", categories: [] };
    }
  }

  // CAM: the Collector reads wide and groups the batch; the Proposal Generator gates
  // EACH category (confirmsProposal). Below-threshold/uncategorised rows stay queued —
  // nothing is dropped. Counts/patterns/gate are surfaced for /feed + /approvals.
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
  return { project, aggregated, flagged, validated, trigger, roundId, categories };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = Number(getFlag(argv, "limit") ?? "20") || 20;
  const validate = hasFlag(argv, "validate-stale");
  const allProjects = hasFlag(argv, "all-projects");

  const db = openWithMigrate();
  // --all-projects sweeps every project with queued feedback (the scheduled drainer);
  // single-project keeps the original default of arc-webui.
  const projects = allProjects ? projectsWithOpenFeedback(db) : [getFlag(argv, "project") ?? "arc-webui"];

  const results = projects.map((p) => aggregateProject(db, p, limit, validate));
  const out = allProjects ? { projects: results } : (results[0] ?? { aggregated: 0, categories: [] });
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (import.meta.main) { await main(); }
