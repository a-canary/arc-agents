// Worker prompt templates. Pure data + render — no I/O.
// Resolves (kind, type) → { frame, overlays, opening_skills } and renders to
// the system-prompt string worker-shell.sh feeds to `claude --append-system-prompt`.
//
// Templates are aspirational where the underlying skill doesn't exist yet
// (grill-with-docs, choose-wisely). Listing them is harmless — claude ignores
// unknown skills until they're invoked.

import type { Kind, Type } from "../ledger/bookie-validator";

// Frames = the "who am I and why" stanza. One per use-case.
const FRAMES = {
  afk: `You are an autonomous AFK worker. No human will reply mid-task. Drive the
work to a terminal ledger state (merged + evidence, failed + evidence, or
decompose into HITL children). Make reasonable judgement calls; do not pause
for clarification you cannot get.`,

  interactive: `You are servicing work the user is actively waiting on (next chat reply,
prefetch render, UX response). Latency matters more than thoroughness — ship
the smallest correct answer fast, then exit.`,

  intake: `You are the interviewer for a new thread. Align scope/intent via
grill-with-docs, cascade design choices via choose-wisely against CHOICES.md,
then decompose the aligned intent into ledger rows via the bookie.`,
} as const;

// Overlays = always-on style/policy notes appended after the frame.
const CAVEMAN = `Reply terse. Imperative voice. Drop articles. No hedging. No trailing
summaries. Github-commit cadence.`;

const BOOKIE_ROUTING = `All ledger WRITES (create, update, decompose, event) route through the
bookie subagent via the Agent tool. Reads (show, list) stay direct.`;

const COMMIT_AUTHOR = `Commit as the configured git user (\`git config user.name\`). Do not
hardcode any author name.`;

// (kind, type) → template. Falls back to generic afk-task.
type Template = {
  frame: keyof typeof FRAMES;
  opening_skills: string[];
  extras?: string[];
};

const TABLE: Partial<Record<`${Kind}/${Type}`, Template>> = {
  "task/interactive": { frame: "interactive", opening_skills: ["ke-recall"] },
  "task/HITL": { frame: "afk", opening_skills: ["ke-recall", "to-ledger"] },
  "task/cron": { frame: "afk", opening_skills: ["ke-recall"] },
  "task/mvp": { frame: "afk", opening_skills: ["ke-recall", "to-ledger", "triage-failed"] },
  "task/security": { frame: "afk", opening_skills: ["ke-recall", "to-ledger", "triage-failed"] },
  "task/quality": { frame: "afk", opening_skills: ["ke-recall", "to-ledger", "triage-failed"] },
  "task/scale": { frame: "afk", opening_skills: ["ke-recall", "to-ledger"] },
  "task/efficiency": { frame: "afk", opening_skills: ["ke-recall", "to-ledger"] },
  "task/deferred": { frame: "afk", opening_skills: ["ke-recall"] },

  "chat_in/interactive": { frame: "intake", opening_skills: ["ke-recall", "grill-with-docs", "choose-wisely"] },
  "chat_out/interactive": { frame: "interactive", opening_skills: [] },
  "prefetch/interactive": { frame: "interactive", opening_skills: ["to-ledger"] },
  "encounter_reply/interactive": { frame: "interactive", opening_skills: ["grill-with-docs"] },

  "prd/mvp": { frame: "intake", opening_skills: ["grill-with-docs", "choose-wisely"] },
};

const DEFAULT_TEMPLATE: Template = { frame: "afk", opening_skills: ["ke-recall"] };

export function resolveTemplate(kind: string, type: string): Template {
  return TABLE[`${kind}/${type}` as keyof typeof TABLE] ?? DEFAULT_TEMPLATE;
}

export type RenderInput = {
  kind: string;
  type: string;
  worker: string;
  task: string;
};

export function renderSystemPrompt(input: RenderInput): string {
  const t = resolveTemplate(input.kind, input.type);
  const skillsLine = t.opening_skills.length
    ? `Opening skills (load on first turn): ${t.opening_skills.map((s) => `/${s}`).join(", ")}.`
    : "";
  return [
    `kind=${input.kind}; type=${input.type}; worker=${input.worker}; task=${input.task}; ephemeral.`,
    FRAMES[t.frame],
    CAVEMAN,
    skillsLine,
    BOOKIE_ROUTING,
    COMMIT_AUTHOR,
    ...(t.extras ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}
