// Pure validators for bookie writes. No db access — all funcs total over inputs.
// Used by bin/ledger.ts to reject positional create and bad enums before they
// hit the schema CHECK and corrupt error messages with raw SQLITE_CONSTRAINT.

export const KIND_VALUES = [
  "task",
  "event",
  "reply",
  "prd",
  "prefetch",
] as const;
export type Kind = (typeof KIND_VALUES)[number];

export const TYPE_VALUES = [
  "interactive",
  "HITL",
  "cron",
  "mvp",
  "security",
  "quality",
  "scale",
  "efficiency",
  "deferred",
] as const;
export type Type = (typeof TYPE_VALUES)[number];

export const STATE_VALUES = [
  "ready",
  "claimed",
  "wip",
  "blocked",
  "review",
  "merged",
  "cancelled",
  "failed",
] as const;
export type State = (typeof STATE_VALUES)[number];

export type CreateInput = {
  title?: string;
  kind?: string;
  type?: string;
  project?: string;
  body?: string;
  acceptance?: string;
  parent?: string | null;
  blockedBy?: string | null;
};

export type ValidationError = { field: string; message: string };

export function validateCreate(input: CreateInput, positional: string[] = []): ValidationError[] {
  const errs: ValidationError[] = [];

  if (positional.length > 0) {
    errs.push({
      field: "args",
      message: `positional args not allowed for create: got [${positional.join(", ")}]. use --title, --kind, --type, --project`,
    });
  }

  if (!input.title || input.title.startsWith("--")) {
    errs.push({ field: "--title", message: "required and must not look like a flag" });
  }
  if (!input.kind || !KIND_VALUES.includes(input.kind as Kind)) {
    errs.push({ field: "--kind", message: `must be one of: ${KIND_VALUES.join(", ")}` });
  }
  if (!input.type || !TYPE_VALUES.includes(input.type as Type)) {
    errs.push({ field: "--type", message: `must be one of: ${TYPE_VALUES.join(", ")}` });
  }
  if (input.blockedBy && !looksLikeJsonArray(input.blockedBy)) {
    errs.push({ field: "--blocked-by", message: "must be a JSON array of issue ids, e.g. '[\"i-foo\"]'" });
  }

  return errs;
}

function looksLikeJsonArray(s: string): boolean {
  if (!s.startsWith("[") || !s.endsWith("]")) return false;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) && v.every((x) => typeof x === "string");
  } catch {
    return false;
  }
}

export type DecomposeInput = {
  parent?: string;
  children?: string[];
};

export function validateDecompose(input: DecomposeInput): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!input.parent || input.parent.startsWith("--")) {
    errs.push({ field: "parent", message: "required (positional <parent-id>)" });
  }
  const children = input.children ?? [];
  if (children.length === 0) {
    errs.push({ field: "--child", message: "at least one --child required" });
  }
  if (children.length > 5) {
    errs.push({ field: "--child", message: "fanout cap of 5 exceeded" });
  }
  for (const c of children) {
    if (!c || c.startsWith("--")) {
      errs.push({ field: "--child", message: `bad child title: '${c}'` });
    }
  }
  return errs;
}

export function validateStateTransition(from: State, to: State): ValidationError[] {
  if (from === to) return [];
  // Terminal states are merged|cancelled — these are forever.
  if (from === "merged" || from === "cancelled") {
    return [{ field: "state", message: `cannot transition out of terminal state '${from}'` }];
  }
  return [];
}
