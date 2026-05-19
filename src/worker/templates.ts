// Worker prompt templates. Metadata + render — prompt text lives in markdown
// under roles/ so humans edit prose, not TS string literals.
//
// Render reads frames/overlays/doctrine from disk and assembles the string
// fed to `claude --append-system-prompt` via worker-shell.sh.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kind, Type } from "../ledger/bookie-validator";

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

const DEFAULT_OVERLAYS = ["caveman", "bookie-routing", "commit-author", "diff-review"];
const DEFAULT_DOCTRINE = ["AGENTS.md"];

const TABLE: Partial<Record<`${Kind}/${Type}`, Template>> = {
  "task/interactive":   { frame: "interactive", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall"] },
  "task/HITL":          { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "to-ledger"] },
  "task/cron":          { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall"] },
  "task/mvp":           { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "to-ledger", "triage-failed"] },
  "task/security":      { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "to-ledger", "triage-failed"] },
  "task/quality":       { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "to-ledger", "triage-failed"] },
  "task/scale":         { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "to-ledger"] },
  "task/efficiency":    { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "to-ledger"] },
  "task/deferred":      { frame: "afk",         overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall"] },

  "event/interactive":           { frame: "intake",      overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["ke-recall", "grill-with-docs", "choose-wisely"] },
  "reply/interactive":           { frame: "interactive", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: [] },
  "prefetch/interactive":        { frame: "interactive", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["to-ledger"] },

  "prd/mvp": { frame: "intake", overlays: DEFAULT_OVERLAYS, doctrine: DEFAULT_DOCTRINE, opening_skills: ["grill-with-docs", "choose-wisely"] },
};

const DEFAULT_TEMPLATE: Template = {
  frame: "afk",
  overlays: DEFAULT_OVERLAYS,
  doctrine: DEFAULT_DOCTRINE,
  opening_skills: ["ke-recall"],
};

export function resolveTemplate(kind: string, type: string): Template {
  return TABLE[`${kind}/${type}` as keyof typeof TABLE] ?? DEFAULT_TEMPLATE;
}

export type RenderInput = {
  kind: string;
  type: string;
  worker: string;
  task: string;
  thread_id?: string;
  /**
   * Pre-rendered thread replay block (see `src/worker/thread-context.ts`).
   * Pass empty string when there's no thread or no prior turns.
   */
  thread_replay?: string;
};

export function renderSystemPrompt(input: RenderInput): string {
  const t = resolveTemplate(input.kind, input.type);
  const frame = readMd(`frames/${t.frame}.md`);
  const overlays = t.overlays.map((o) => readMd(`overlays/${o}.md`));
  const doctrine = t.doctrine.map((d) => readMd(d));
  const skillsLine = t.opening_skills.length
    ? `Opening skills (load on first turn): ${t.opening_skills.map((s) => `/${s}`).join(", ")}.`
    : "";
  const header = input.thread_id
    ? `kind=${input.kind}; type=${input.type}; worker=${input.worker}; task=${input.task}; thread=${input.thread_id}; ephemeral.`
    : `kind=${input.kind}; type=${input.type}; worker=${input.worker}; task=${input.task}; ephemeral.`;
  return [
    header,
    frame,
    ...overlays,
    skillsLine,
    ...doctrine,
    input.thread_replay ?? "",
    ...(t.extras ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}
