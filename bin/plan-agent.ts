#!/usr/bin/env bun
// plan-agent.ts — the L6 Planning Agent (ADR-0010). arc-webui /chat spawns this as
// a detached subprocess (never inside the Hono process). It turns a free-text dev
// request into a real PRD + decomposed tracer slices, then emits them through the
// deterministic plan.ts gate-writer. It PRODUCES proposals only — never spawns
// implementation workers, merges, or deploys.
//
//   plan-agent.ts --request "<text>" [--thread T] [--project P]
//
// Design: the model IS the planning agent. We run one headless `claude -p` with
// read-only tools (Read/Grep/Glob) and its cwd set to the target repo, so it actually
// researches the codebase — CONTEXT.md glossary, docs/adr/, the modules the request
// touches — before emitting a structured PRD as JSON. (The earlier no-tools MiniMax
// single-shot did zero research and produced thin, generic plans; the pi upgrade then
// 429'd the hosted token plan and every draft degraded to the bare-request fallback.)
// The wrapper stays deterministic: it builds the prompt, parses the JSON, and on any
// failure (non-zero exit, timeout, unparseable output) falls back to the deterministic
// emitter shape — a bad run degrades, never drops the request. The human approval gate
// keeps any weak draft harmless.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { PROJECT_REPO_MAP } from "../src/project-repo-map";

// A candidate mission objective the planner may propose alongside the PRD (M-0010).
// goal is the only required field; metric/gate are optional. provenance is DELIBERATELY
// absent — the writer pins it (see serializeObjective), it is never caller-settable.
export type ProposedObjective = { goal: string; metric?: string; gate?: string };

export type RelationshipKind = "orthogonal" | "replace" | "dependency" | "fork";
export type Relationship = { other_prd_id: string; kind: RelationshipKind };

export type Plan = {
  title: string;
  body_md: string;
  tracers: string[];
  objective?: ProposedObjective;
  // Pairwise classification against every in-flight / recently-proposed PRD.
  // Parent PRD user-webui-chat-planner-should-be-tasked-isz6 (PR #18): emit
  // orthogonal|replace|dependency|fork per pair. Optional at the type level so
  // hand-built Plan literals (and the objective-only slice-B path) need not
  // restate it; parsePlanJson / buildFallbackPlan always populate it, and
  // planToPlanArgs treats a missing value as [] (never silently drops a pair).
  relationships?: Relationship[];
};

// serializeObjective — the slice-B writer. Turns a proposed objective into the exact
// M-0010 ```objectives``` fence line arc-webui's parseObjectives reads:
//   - goal: X | provenance: inferred | metric: Y | gate: Z
// provenance is HARD-CODED "inferred" (not a parameter): the campaign invariant is that
// agents propose inferred objectives and only a human promotes to user-directed. Enforcing
// it here means no planner path can emit a self-declared user-directed objective. Field
// values are flattened (pipes/newlines stripped) so one objective stays one parseable row.
export function serializeObjective(o: ProposedObjective): string {
  // strip |, newlines, and backticks: the first two break the one-row/pipe-split
  // contract; a backtick in a value could terminate the ```objectives fence early
  // and truncate the reader's block (defense-in-depth — never a legit M-0010 value).
  const flat = (s: string) => s.replace(/[|`\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = [`goal: ${flat(o.goal)}`, "provenance: inferred"];
  if (o.metric && flat(o.metric)) parts.push(`metric: ${flat(o.metric)}`);
  if (o.gate && flat(o.gate)) parts.push(`gate: ${flat(o.gate)}`);
  return "- " + parts.join(" | ");
}

// Baked grill-with-docs grounding: the architecture a plan must respect. Kept as a
// constant (not a file read) because it produces excellent plans on its own (proven)
// and avoids I/O in the hot path.
// ponytail: richer grounding — read CONTEXT.md/ADRs + `ke recall <request>` and inject
// them here — is a follow-up enrichment (slice 4). The gate keeps thinner drafts safe.
export const ARCH_CONTEXT =
  "PROJECT CONTEXT: arc-webui is a Hono/Bun server-rendered developer portal. Pages " +
  "render to HTML through a shell() helper; there is no client build step. Prefer plain " +
  "CSS and small server routes over any JS framework or new dependency. Every change " +
  "must be small and independently reversible.";

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

// Per-project grounding for the planner prompt. Prefer the target repo's own
// CONTEXT.md glossary (proven richer plans); fall back to the baked arc-webui
// context, or a neutral reversible-first context for an unknown project.
// ponytail: repo is a sibling of arc-agents (../<project>); a missing file just
// degrades to the fallback, never throws.
export function groundingFor(project: string): string {
  try {
    const root = join(import.meta.dir, "..", "..");
    const ctx = readFileSync(join(root, project, "CONTEXT.md"), "utf8").trim();
    if (ctx) return `PROJECT CONTEXT (${project}) — ubiquitous language + constraints:\n${clamp(ctx, 4000)}`;
  } catch {}
  if (project === "arc-webui") return ARCH_CONTEXT;
  return `PROJECT CONTEXT: ${project}. Respect the project's existing architecture, language, and conventions. Keep every change small and independently reversible.`;
}

// The prompt describes the JSON shape in WORDS. A literal json template or a code
// fence in the prompt makes headless MiniMax loop to timeout (proven); never embed one.
export function buildPlanningPrompt(
  request: string,
  context: string,
  project = "arc-webui",
  existingPrdIds: readonly string[] = [],
): string {
  const existingBlock = existingPrdIds.length === 0
    ? "EXISTING PRDs (in-flight / recently-proposed): none. Emit relationships: []."
    : "EXISTING PRDs (in-flight / recently-proposed — classify yourself against each one):\n" +
      existingPrdIds.map((id, i) => `  ${i + 1}. ${id}`).join("\n") +
      "\nEmit one relationships[] entry per id above.";
  return [
    "You are a planning agent for the " + project + " project. Turn the development request below into a thorough PRD.",
    "",
    "REQUEST: " + request,
    "",
    context,
    "",
    existingBlock,
    "",
    "RESEARCH FIRST. You have read-only tools (Read, Grep, Glob) and your working directory is the " + project + " repository. Before you plan, ground yourself in the real codebase:",
    "- Read CONTEXT.md (the ubiquitous-language glossary) and reuse its exact terms.",
    "- Scan docs/adr/ for any ADR that constrains this area and respect its decisions.",
    "- Grep and read the existing modules the request touches, so the plan reuses what is there instead of reinventing it.",
    "Do the reading before you write the plan. A plan that ignores the existing code or contradicts an ADR is wrong.",
    "",
    "Then output a single JSON object and nothing else — no prose, no code fences. Use exactly these keys:",
    "- title: a concise plan title, a string under 80 characters",
    "- body_md: a markdown PRD body, as a string, with these sections in order: Problem (from the user's perspective); Solution (from the user's perspective); User Stories (a long numbered list, each line of the form 'As an <actor>, I want <feature>, so that <benefit>', covering every aspect of the feature); Implementation Decisions (modules to build or modify, their interfaces, schema and contract changes — prose only, no file paths or code snippets); Testing Decisions (which modules to test and what a good behavioural test looks like); Out of Scope.",
    "- tracers: an array of 1 to 3 strings; each a small vertical slice, smallest first, each shippable on its own and independently grabbable by a worker",
    "- objective (OPTIONAL): only if this request implies a NEW, measurable mission-level outcome the project should track, propose ONE candidate objective as an object with keys goal (a short outcome statement), metric (a short machine-readable metric name), and gate (a numeric target like '100-300' or '8', NOT prose). Omit this key entirely when the request is a plain feature with no measurable mission outcome — do not invent one. It will be recorded as an inferred proposal a human reviews and promotes; never mark it directed.",
    "- relationships: an array; one entry per in-flight or recently-proposed PRD (every existing PRD whose state is not cancelled or failed). Each entry is an object with two fields: other_prd_id (the existing PRD's slug) and kind (exactly one of: orthogonal, replace, dependency, fork). orthogonal means no relationship — both can proceed. replace means the new PRD cancels and hides the existing one. dependency means the new PRD cannot be approved until the referenced PRD is approved; if the dependency is cancelled the new PRD is also cancelled. fork means both PRDs are mutually exclusive candidates — approval of one cancels the others. Use orthogonal for any pair you cannot confidently classify; do not omit a pair.",
  ].join("\n");
}

// Defensive parse: the model may wrap the object in prose or a fence despite the
// instruction. Strip a fence if present, else take the outermost braces, then validate.
const RELATIONSHIP_KINDS: ReadonlySet<RelationshipKind> = new Set([
  "orthogonal",
  "replace",
  "dependency",
  "fork",
]);

export function parsePlanJson(stdout: string): Plan | null {
  if (!stdout) return null;
  let s = stdout.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + 1);
  let obj: { title?: unknown; body_md?: unknown; tracers?: unknown; objective?: unknown; relationships?: unknown };
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj.title !== "string" || !obj.title.trim()) return null;
  if (!Array.isArray(obj.tracers) || obj.tracers.length === 0) return null;
  const tracers = obj.tracers
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim());
  if (tracers.length === 0) return null;
  // Relationships are optional in the wire format — a missing/empty array
  // is fine; buildFallbackPlan re-emits defaults at the deterministic path.
  // We still drop entries with invalid kind values so a CHECK-constraint
  // violation is impossible at the persistence layer.
  const relationships: Relationship[] = [];
  if (Array.isArray(obj.relationships)) {
    for (const r of obj.relationships) {
      if (!r || typeof r !== "object") continue;
      const o = r as { other_prd_id?: unknown; kind?: unknown };
      if (typeof o.other_prd_id !== "string" || !o.other_prd_id.trim()) continue;
      if (typeof o.kind !== "string") continue;
      if (!RELATIONSHIP_KINDS.has(o.kind as RelationshipKind)) continue;
      relationships.push({
        other_prd_id: o.other_prd_id.trim(),
        kind: o.kind as RelationshipKind,
      });
    }
  }
  return {
    title: obj.title.trim(),
    body_md: typeof obj.body_md === "string" ? obj.body_md : "",
    tracers: tracers.slice(0, 5),
    objective: parseObjective(obj.objective),
    relationships,
  };
}

// A proposed objective is optional and must not sink the whole plan: a missing key, a
// non-object, or a goal-less object all degrade to undefined (no proposal), never null.
function parseObjective(raw: unknown): ProposedObjective | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as { goal?: unknown; metric?: unknown; gate?: unknown };
  if (typeof o.goal !== "string" || !o.goal.trim()) return undefined;
  const out: ProposedObjective = { goal: o.goal.trim() };
  if (typeof o.metric === "string" && o.metric.trim()) out.metric = o.metric.trim();
  if (typeof o.gate === "string" && o.gate.trim()) out.gate = o.gate.trim();
  return out;
}

// Deterministic degrade path: request becomes a thin PRD + one tracer. Exported for
// tests and callers that want a safe default; the auto-planner main() path deliberately
// does NOT use it (it fail-fasts instead — see main()). `existingPrdIds` forces every
// pair to 'orthogonal' because the model had no chance to reason.
export function buildFallbackPlan(request: string, existingPrdIds: readonly string[] = []): Plan {
  const title = clamp(request, 80);
  const relationships: Relationship[] = existingPrdIds.map((other_prd_id) => ({
    other_prd_id,
    kind: "orthogonal",
  }));
  return { title, body_md: request, tracers: [`Implement: ${title}`], relationships };
}

export function planToPlanArgs(plan: Plan, project: string, thread: string): string[] {
  const argv = [
    "--project", project,
    "--thread", thread,
    "--title", clamp(plan.title, 80),
    "--body", withProposedObjective(plan.body_md, plan.objective),
  ];
  for (const t of plan.tracers) argv.push("--tracer", t);
  for (const r of plan.relationships ?? []) argv.push("--relationship", JSON.stringify(r));
  return argv;
}

// Append a proposed objective to the PRD body as a real, parseable M-0010 ```objectives```
// fence, wrapped in a heading that tells the human reviewer this is an INFERRED proposal to
// promote by hand (copy the block into the project's CHOICES.md, edit provenance to
// user-directed) — never an applied change. No objective proposed → body unchanged.
function withProposedObjective(body: string, objective?: ProposedObjective): string {
  if (!objective) return body;
  return (
    body +
    "\n\n## Proposed objective (inferred — human promotes)\n\n" +
    "The planner inferred a candidate mission objective from this request. To adopt it, " +
    "copy the block below into this project's CHOICES.md `objectives` fence and change " +
    "`provenance: inferred` to `user-directed`. Leaving it inferred, or deleting it, is fine.\n\n" +
    "```objectives\n" + serializeObjective(objective) + "\n```\n"
  );
}

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

// Generate the plan with one headless `claude -p` run that researches the target repo
// (read-only Read/Grep/Glob, cwd = the repo) before emitting the PRD JSON. The prompt
// goes in via stdin so the variadic --allowedTools list can't swallow it. Returns null
// on non-zero exit, timeout, or unparseable output → caller falls back.
function generatePlan(prompt: string, project: string): Plan | null {
  const claude = Bun.which("claude") ?? "claude";
  const repo = join(import.meta.dir, "..", "..", project);
  const cwd = existsSync(repo) ? repo : import.meta.dir;
  const r = spawnSync(
    claude,
    ["-p", "--allowedTools", "Read", "Grep", "Glob"],
    { encoding: "utf8", timeout: 300_000, cwd, input: prompt },
  );
  if (r.status !== 0 || !r.stdout) return null;
  return parsePlanJson(r.stdout);
}

// Pull the slugs of every in-flight / recently-proposed PRD so the prompt can
// hand the planner a concrete list to classify itself against. Cancelled /
// failed PRDs are excluded (no relationship possible — they're gone).
// ponytail: a glob over `ledger list --kind prd` is cheaper than wiring a new
// SQL query into the bookie for this read-only lookup; the list path already
// supports the --kind filter and returns JSON. We parse stdout and filter in
// memory — at ~hundreds of PRDs the cost is trivial vs. the LLM call.
export function listExistingPrdIds(project: string): string[] {
  const ledger = join(import.meta.dir, "ledger.ts");
  const r = spawnSync(process.execPath, [ledger, "list", "--kind", "prd", "--all", "--project", project], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const rows = JSON.parse(r.stdout) as Array<{ id?: unknown; state?: unknown }>;
    return rows
      .filter((row) => typeof row.id === "string" && row.state !== "cancelled" && row.state !== "failed")
      .map((row) => row.id as string);
  } catch {
    return [];
  }
}

// Refuse to mint an issue whose project has no repo checkout — mirrors worker-shell.sh's
// resolve_repo()/ARC_PROJECT_REPO_<UPPER> convention so a minted issue is always claimable.
export function resolveProjectRepo(project: string): string | null {
  const override = process.env[`ARC_PROJECT_REPO_${project.toUpperCase().replace(/-/g, "_")}`];
  if (override) return override;
  const repoDir = PROJECT_REPO_MAP[project] ?? project;
  const repo = join(import.meta.dir, "..", "..", repoDir);
  return existsSync(repo) ? repo : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const request = (getFlag(argv, "request") ?? "").trim();
  if (!request) { process.stderr.write("plan-agent: --request is required\n"); process.exit(2); }
  const thread = getFlag(argv, "thread") ?? "t-" + Math.random().toString(36).slice(2, 10);
  // Empty/whitespace --project (e.g. /chat/draft call before chat_meta.project
  // is set) must NOT propagate empty to the minted PRD (see
  // analysis-1783934070.md Pattern 3 — 6 webui→arc-agents misroutes on
  // 2026-07-13 from kind=prd rows filed with project='').
  const project = getFlag(argv, "project")?.trim() || "arc-webui";
  if (!resolveProjectRepo(project)) {
    process.stderr.write(
      `plan-agent: project '${project}' has no repo mapping — refusing to mint an unroutable issue. ` +
        `Set ARC_PROJECT_REPO_${project.toUpperCase().replace(/-/g, "_")}=/path/to/repo or route feedback to a concrete project.\n`,
    );
    process.exit(1);
  }

  // Existing PRD slugs — read once and fed to the prompt so the planner knows what
  // to classify against (pairwise relationships).
  const existingPrdIds = listExistingPrdIds(project);

  const prompt = buildPlanningPrompt(request, groundingFor(project), project, existingPrdIds);
  const plan = generatePlan(prompt, project);
  if (!plan) {
    // No bare-request fallback: minting the prompt itself as a PRD polluted the
    // approvals gate (prompt-shaped "PRDs") AND marked the source feedback resolved.
    // Fail instead — the auto-planner caller leaves the feedback 'new', and a later
    // tick retries (the claude -p engine is intermittent, so retry converges on a
    // real plan). Silent stall beats silent corruption.
    process.stderr.write("plan-agent: research engine returned no plan — failing (feedback stays new, retries next tick; check claude binary / 300s timeout)\n");
    process.exit(1);
  }

  const planBin = join(import.meta.dir, "plan.ts");
  const r = spawnSync(process.execPath, [planBin, ...planToPlanArgs(plan, project, thread)], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status !== 0) { process.stderr.write(`plan-agent: plan.ts failed: ${r.stderr || r.stdout}\n`); process.exit(1); }
  process.stdout.write(r.stdout);
}

if (import.meta.main) { await main(); }
