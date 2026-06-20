// Worker prompt templates. Metadata + render — prompt text lives in markdown
// under roles/ so humans edit prose, not TS string literals.
//
// Render reads frames/overlays/doctrine from disk and assembles the string
// fed to `claude --append-system-prompt` via worker-shell.sh.
//
// Frame resolution is keyed on (agent, pool):
//   - agent determines identity: opening_skills, overlays, doctrine
//   - pool determines human-presence: frame (sprint overrides pool entirely)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "roles");

function readMd(rel: string): string {
  return readFileSync(join(ROLES_DIR, rel), "utf8").trim();
}

type FrameName = "afk" | "interactive" | "intake" | "sprint";

type Template = {
  frame: FrameName;
  overlays: string[];   // file stems under roles/overlays/
  doctrine: string[];   // file paths relative to roles/
  opening_skills: string[];
  extras?: string[];
};

const DEFAULT_OVERLAYS = ["caveman", "bookie-routing", "commit-author", "diff-review"];
const DEFAULT_DOCTRINE = ["AGENTS.md"];

// Agent identity: opening_skills (+ overlays/doctrine when agent-specific overrides needed).
// All agents use DEFAULT_OVERLAYS + DEFAULT_DOCTRINE unless specified otherwise.
type AgentKey = string;
type AgentOverride = Pick<Template, "opening_skills" | "overlays" | "doctrine" | "extras">;

const AGENT_TABLE: Partial<Record<AgentKey, AgentOverride>> = {
  developer: {
    opening_skills: ["ke-recall", "anti-sycophancy", "to-ledger", "triage-failed"],
    overlays: DEFAULT_OVERLAYS,
    doctrine: DEFAULT_DOCTRINE,
  },
  director: {
    opening_skills: ["ke-recall", "grill-with-docs", "choose-wisely"],
    overlays: DEFAULT_OVERLAYS,
    doctrine: DEFAULT_DOCTRINE,
  },
  admin: {
    opening_skills: ["ke-recall"],
    overlays: DEFAULT_OVERLAYS,
    doctrine: DEFAULT_DOCTRINE,
  },
  chat: {
    opening_skills: ["ke-recall", "grill-with-docs", "choose-wisely"],
    overlays: DEFAULT_OVERLAYS,
    doctrine: DEFAULT_DOCTRINE,
  },
  triage: {
    opening_skills: ["ke-recall", "triage-assign"],
    overlays: DEFAULT_OVERLAYS,
    doctrine: DEFAULT_DOCTRINE,
  },
  sprint: {
    opening_skills: ["ke-recall", "sprint-supervise"],
    overlays: DEFAULT_OVERLAYS,
    doctrine: DEFAULT_DOCTRINE,
  },
  // bookie and agent_unset fall to DEFAULT — shouldn't normally render a
  // worker prompt (bookie is a subagent; unset is drained by triage first),
  // but don't crash if they do.
};

const DEFAULT_TEMPLATE: Template = {
  frame: "afk",
  overlays: DEFAULT_OVERLAYS,
  doctrine: DEFAULT_DOCTRINE,
  opening_skills: ["ke-recall"],
};

/**
 * Resolve (agent, pool) to a Template.
 *
 * Frame resolution (human-presence dimension):
 *   sprint → "sprint" frame (overrides pool — re-entrant supervisor)
 *   director | chat → "intake" frame (interviewers/grill)
 *   pool === "interactive" → "interactive" frame
 *   else → "afk" frame (autonomous default)
 *
 * Opening skills / overlays / doctrine come from AGENT_TABLE keyed on agent.
 * Unknown agents fall back to DEFAULT_TEMPLATE.
 */
export function resolveTemplate(agent: string, pool: string): Template {
  // Frame: sprint overrides everything
  let frame: FrameName;
  if (agent === "sprint") {
    frame = "sprint";
  } else if (agent === "director" || agent === "chat") {
    frame = "intake";
  } else if (pool === "interactive") {
    frame = "interactive";
  } else {
    frame = "afk";
  }

  const override = AGENT_TABLE[agent];
  if (!override) return { ...DEFAULT_TEMPLATE, frame };

  return {
    frame,
    overlays: override.overlays ?? DEFAULT_OVERLAYS,
    doctrine: override.doctrine ?? DEFAULT_DOCTRINE,
    opening_skills: override.opening_skills,
    extras: override.extras,
  };
}

export type RenderInput = {
  kind: string;
  agent: string;
  pool: string;
  worker: string;
  task: string;
  thread_id?: string;
  /**
   * Pre-rendered thread replay block (see `src/worker/thread-context.ts`).
   * Pass empty string when there's no thread or no prior turns.
   */
  thread_replay?: string;
  /**
   * Optional brief from the human — injected as a ## Brief section between
   * thread_replay and extras. Preserved here so Aaron's production overlay
   * merges cleanly when this branch FF-merges to main.
   */
  brief?: string;
  /**
   * Prior-work handoff (the row's evidence_md) surfaced when a task is
   * re-claimed after a worker died or blocked mid-task. Rendered as a
   * "## Prior work" section so the cold worker resumes instead of restarting.
   */
  handoff?: string;
  /**
   * Skills from the agent's profile (profiles/<agent>.json). When present these
   * are the single source of truth — boot_skills overrides AGENT_TABLE's
   * opening_skills, stop_skills renders a "run before exit" line. Omitted for
   * agents that have no profile (chat, bookie, unset) → AGENT_TABLE fallback.
   */
  boot_skills?: string[];
  stop_skills?: string[];
};

export function renderSystemPrompt(input: RenderInput): string {
  const t = resolveTemplate(input.agent, input.pool);
  const frame = readMd(`frames/${t.frame}.md`);
  const overlays = t.overlays.map((o) => readMd(`overlays/${o}.md`));
  const doctrine = t.doctrine.map((d) => readMd(d));
  // Profile is authoritative when supplied; AGENT_TABLE is the fallback for
  // profile-less agents. Keeps the prompt in sync with hooks/session-start.sh,
  // which prints the same profile.boot_skills.
  const openingSkills = input.boot_skills?.length ? input.boot_skills : t.opening_skills;
  const skillsLine = openingSkills.length
    ? `Opening skills (load on first turn): ${openingSkills.map((s) => `/${s}`).join(", ")}.`
    : "";
  const closingSkillsLine = input.stop_skills?.length
    ? `Closing skills (run before exit): ${input.stop_skills.map((s) => `/${s}`).join(", ")}.`
    : "";
  const header = input.thread_id
    ? `kind=${input.kind}; agent=${input.agent}; pool=${input.pool}; worker=${input.worker}; task=${input.task}; thread=${input.thread_id}; ephemeral.`
    : `kind=${input.kind}; agent=${input.agent}; pool=${input.pool}; worker=${input.worker}; task=${input.task}; ephemeral.`;
  const briefSection = input.brief?.trim()
    ? `## Brief\n\n${input.brief.trim()}`
    : "";
  const handoffSection = input.handoff?.trim()
    ? `## Prior work — resume from here\n\nThis task was worked before. Continue it; do not restart.\n\n${input.handoff.trim()}`
    : "";
  return [
    header,
    frame,
    ...overlays,
    skillsLine,
    closingSkillsLine,
    ...doctrine,
    input.thread_replay ?? "",
    handoffSection,
    briefSection,
    ...(t.extras ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}
