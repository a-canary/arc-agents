// Worker prompt templates. Metadata + render — prompt text lives in markdown
// under roles/ so humans edit prose, not TS string literals.
//
// Render reads frames/overlays/doctrine from disk and assembles the string
// fed to `claude --append-system-prompt` via worker-shell.sh.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kind, Urgency } from "../ledger/bookie-validator";

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "roles");

function readMd(rel: string): string {
  return readFileSync(join(ROLES_DIR, rel), "utf8").trim();
}

type FrameName = "afk" | "interactive" | "intake";

type Template = {
  frame: FrameName;
  overlays: string[];   // file stems under roles/overlays/
  doctrine: string[];   // file paths relative to roles/
  opening_skills: string[];
  extras?: string[];
};

const DEFAULT_OVERLAYS = ["caveman", "bookie-routing", "commit-author"];
const DEFAULT_DOCTRINE = ["AGENTS.md"];

// Keyed by `${kind}/${urgency}`. hitl=1 task rows are routed to a dedicated
// HITL template below in resolveTemplate (before urgency lookup).
const TABLE: Partial<Record<`${Kind}/${Urgency}`, Template>> = {
  "task/interactive":   { frame: "interactive", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall"] },
  "task/nominal":       { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "to-ledger", "triage-failed"] },
  "task/deferred":      { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall"] },

  "event/interactive":           { frame: "intake",      overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "grill-with-docs", "choose-wisely"] },
  "reply/interactive":           { frame: "interactive", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: [] },
  "prefetch/interactive":        { frame: "interactive", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["to-ledger"] },

  "prd/nominal": { frame: "intake", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["grill-with-docs", "choose-wisely"] },
};

const HITL_TEMPLATE: Template = {
  frame: "afk",
  overlays: DEFAULT_OVERLAYS,
  doctrine: DEFAULT_DOCTRINE,
  opening_skills: ["ke-recall", "to-ledger"],
};

const DEFAULT_TEMPLATE: Template = {
  frame: "afk",
  overlays: DEFAULT_OVERLAYS,
  doctrine: DEFAULT_DOCTRINE,
  opening_skills: ["ke-recall"],
};

export function resolveTemplate(kind: string, urgency: string, hitl = 0): Template {
  if (kind === "task" && hitl === 1) return HITL_TEMPLATE;
  return TABLE[`${kind}/${urgency}` as keyof typeof TABLE] ?? DEFAULT_TEMPLATE;
}

export type ThreadTurn = { id: string; kind: string; title: string; body: string };

export type RenderInput = {
  kind: string;
  urgency: string;
  hitl?: number;
  worker: string;
  task: string;
  thread_id?: string;
  thread_history?: ThreadTurn[];
};

export function renderSystemPrompt(input: RenderInput): string {
  const t = resolveTemplate(input.kind, input.urgency, input.hitl ?? 0);
  const frame = readMd(`frames/${t.frame}.md`);
  const overlays = t.overlays.map((o) => readMd(`overlays/${o}.md`));
  const doctrine = t.doctrine.map((d) => readMd(d));
  const skillsLine = t.opening_skills.length
    ? `Opening skills (load on first turn): ${t.opening_skills.map((s) => `/${s}`).join(", ")}.`
    : "";
  const hitl = input.hitl ?? 0;
  const header = input.thread_id
    ? `kind=${input.kind}; urgency=${input.urgency}; hitl=${hitl}; worker=${input.worker}; task=${input.task}; thread=${input.thread_id}; ephemeral.`
    : `kind=${input.kind}; urgency=${input.urgency}; hitl=${hitl}; worker=${input.worker}; task=${input.task}; ephemeral.`;
  const replay = renderThreadReplay(input.thread_history);
  return [
    header,
    frame,
    ...overlays,
    skillsLine,
    ...doctrine,
    replay,
    ...(t.extras ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderThreadReplay(turns: ThreadTurn[] | undefined): string {
  if (!turns || turns.length === 0) return "";
  const lines = turns.map((t) => {
    const speaker = t.kind === "event" ? "user" : "you";
    const body = t.body.trim() || t.title;
    return `[${speaker}] ${body}`;
  });
  return `Prior turns in this thread (oldest first):\n${lines.join("\n")}`;
}
