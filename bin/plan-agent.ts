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

export type Plan = { title: string; body_md: string; tracers: string[] };

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
export function buildPlanningPrompt(request: string, context: string, project = "arc-webui"): string {
  return [
    "You are a planning agent for the " + project + " project. Turn the development request below into a thorough PRD.",
    "",
    "REQUEST: " + request,
    "",
    context,
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
  ].join("\n");
}

// Defensive parse: the model may wrap the object in prose or a fence despite the
// instruction. Strip a fence if present, else take the outermost braces, then validate.
export function parsePlanJson(stdout: string): Plan | null {
  if (!stdout) return null;
  let s = stdout.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + 1);
  let obj: { title?: unknown; body_md?: unknown; tracers?: unknown };
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj.title !== "string" || !obj.title.trim()) return null;
  if (!Array.isArray(obj.tracers) || obj.tracers.length === 0) return null;
  const tracers = obj.tracers
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim());
  if (tracers.length === 0) return null;
  return {
    title: obj.title.trim(),
    body_md: typeof obj.body_md === "string" ? obj.body_md : "",
    tracers: tracers.slice(0, 5),
  };
}

// Deterministic degrade path (== slice-1/2 emitter): request becomes a thin PRD + one
// tracer. Used when the model run fails, times out, or returns unparseable output.
export function buildFallbackPlan(request: string): Plan {
  const title = clamp(request, 80);
  return { title, body_md: request, tracers: [`Implement: ${title}`] };
}

export function planToPlanArgs(plan: Plan, project: string, thread: string): string[] {
  const argv = [
    "--project", project,
    "--thread", thread,
    "--title", clamp(plan.title, 80),
    "--body", plan.body_md,
  ];
  for (const t of plan.tracers) argv.push("--tracer", t);
  return argv;
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const request = (getFlag(argv, "request") ?? "").trim();
  if (!request) { process.stderr.write("plan-agent: --request is required\n"); process.exit(2); }
  const thread = getFlag(argv, "thread") ?? "t-" + Math.random().toString(36).slice(2, 10);
  const project = getFlag(argv, "project") ?? "arc-webui";

  const prompt = buildPlanningPrompt(request, groundingFor(project), project);
  let plan = generatePlan(prompt, project);
  if (!plan) {
    // Make degradation loud: a slow repo can hit the 300s timeout and silently fall
    // back to a bare-request PRD — the exact regression this engine swap fixed.
    process.stderr.write("plan-agent: research engine returned no plan — using bare-request fallback (check claude binary / 300s timeout)\n");
    plan = buildFallbackPlan(request);
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
