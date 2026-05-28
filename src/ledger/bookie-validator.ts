// Pure validators for bookie writes. No db access — all funcs total over inputs.
// Used by bin/ledger.ts to reject positional create and bad enums before they
// hit the schema CHECK and corrupt error messages with raw SQLITE_CONSTRAINT.

export const KIND_VALUES = [
  "task",
  "event",
  "reply",
  "prd",
  "prefetch",
  "sprint",
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

// ADR 0005: orthogonal class + urgency replace single `type`.
// Owned by `schema-enums.ts`; re-exported here so callers of bookie-validator
// keep working unchanged.
export { CLASS_VALUES, URGENCY_VALUES, TIER_VALUES, POOL_VALUES, AGENT_VALUES } from "./schema-enums";
export type { Class, Urgency, Tier, Pool, Agent } from "./schema-enums";
import { CLASS_VALUES, URGENCY_VALUES, TIER_VALUES, POOL_VALUES } from "./schema-enums";
import type { Class, Urgency, Tier, Pool } from "./schema-enums";

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
  // Migration 017: tier/pool replace class/urgency
  tier?: string;
  pool?: string;
  // Legacy aliases (still accepted for backwards compat; ledger.ts maps them)
  class?: string;
  urgency?: string;
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
  // ADR 0005 → Migration 017: --tier/--pool (replaces --class/--urgency).
  // Accept both old and new flag names for backwards compat.
  const tierVal = input.tier ?? input.class;
  const poolVal = input.pool ?? input.urgency;
  if (tierVal !== undefined && !TIER_VALUES.includes(tierVal as Tier) && !CLASS_VALUES.includes(tierVal as Class)) {
    errs.push({ field: "--tier", message: `must be one of: ${TIER_VALUES.join(", ")}` });
  }
  if (poolVal !== undefined && !POOL_VALUES.includes(poolVal as Pool) && !URGENCY_VALUES.includes(poolVal as Urgency)) {
    errs.push({ field: "--pool", message: `must be one of: ${POOL_VALUES.join(", ")}` });
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
    errs.push({ field: "--child", message: `fanout cap of 5 exceeded (got ${children.length})` });
  }
  for (const c of children) {
    if (!c || c.startsWith("--")) {
      errs.push({ field: "--child", message: `bad child title: '${c}'` });
    }
  }
  return errs;
}

// ADR 0005 → Migration 017 bookie write validator. Pure function over (row, registry).
// Enforced on every bookie create/decompose write. Module-registry lookup +
// tier-rationale requirement keep the bookie as sole authority with schema.
export type BookieWriteInput = {
  kind?: string;
  // Migration 017: tier/pool replace class/urgency
  tier?: string;
  pool?: string;
  // Legacy aliases (still accepted; bookie skill should migrate to tier/pool)
  class?: string;
  urgency?: string;
  source_module?: string | null;
  class_rationale?: string | null;
  triage_pending?: boolean;
};

export type ModuleRegistry = ReadonlySet<string>;

export function validateBookieWrite(
  row: BookieWriteInput,
  registry: ModuleRegistry,
): ValidationError[] {
  const errs: ValidationError[] = [];

  if (!row.kind || !KIND_VALUES.includes(row.kind as Kind)) {
    errs.push({ field: "kind", message: `must be one of: ${KIND_VALUES.join(", ")}` });
  }

  // Accept either new (tier) or old (class) field name
  const tierVal = row.tier ?? row.class;
  if (!tierVal || (!TIER_VALUES.includes(tierVal as Tier) && !CLASS_VALUES.includes(tierVal as Class))) {
    errs.push({ field: "tier", message: `must be one of: ${TIER_VALUES.join(", ")}` });
  } else if ((tierVal === "tier_unset" || tierVal === "class_unset") && !row.triage_pending) {
    errs.push({
      field: "tier",
      message: "tier='tier_unset' only allowed with --triage-pending (ADR 0005)",
    });
  }

  // Accept either new (pool) or old (urgency) field name
  const poolVal = row.pool ?? row.urgency;
  if (!poolVal || (!POOL_VALUES.includes(poolVal as Pool) && !URGENCY_VALUES.includes(poolVal as Urgency))) {
    errs.push({ field: "pool", message: `must be one of: ${POOL_VALUES.join(", ")}` });
  }

  // source_module: required for event/reply (matches SQL CHECK). Whenever
  // provided, must resolve in the registry.
  const needsModule = row.kind === "event" || row.kind === "reply";
  if (needsModule && !row.source_module) {
    errs.push({
      field: "source_module",
      message: `source_module required for kind='${row.kind}'`,
    });
  }
  if (row.source_module && !registry.has(row.source_module)) {
    errs.push({
      field: "source_module",
      message: `unknown source_module '${row.source_module}' — not in UX module registry (ADR 0002)`,
    });
  }

  // class_rationale: required on create/decompose unless tier_unset+triage_pending.
  const rationaleExempt = (tierVal === "tier_unset" || tierVal === "class_unset") && !!row.triage_pending;
  if (!rationaleExempt && !row.class_rationale) {
    errs.push({
      field: "class_rationale",
      message: "class_rationale required (cite CHOICES.md/CONTEXT.md per ADR 0005)",
    });
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
