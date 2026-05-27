// ADR 0005 — single source of truth for the (class, urgency) enum pair.
// `bookie-validator.ts` re-exports from here so the SQL CHECK list and the
// runtime validators cannot drift. Migration 011 also generates its CHECK
// lists from these arrays (see `migrate.ts` 011_class_urgency_schema).

export const CLASS_VALUES = [
  "BUG",
  "MVP",
  "ops",
  "hygiene",
  "quality",
  "trust",
  "scale",
  "efficiency",
  "class_unset",
] as const;
export type Class = (typeof CLASS_VALUES)[number];

export const URGENCY_VALUES = ["interactive", "nominal", "deferred"] as const;
export type Urgency = (typeof URGENCY_VALUES)[number];

// SQL-quoted, comma-joined value list, e.g. "'BUG','MVP',...". For use inside
// `CHECK (col IN (${sqlInList(...)}))`. Single-source the enum so a future
// addition only requires editing the array above.
export function sqlInList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(",");
}

// ─── Migration 017: tier/pool/agent enums ────────────────────────────────────
// tier: priority-queue rank (replaces class).
// pool: worker-lane (replaces urgency).
// agent: profile selector (net-new column).

export const TIER_VALUES = [
  "prod",
  "trust",
  "mvp",
  "quality",
  "scale",
  "efficiency",
  "hygiene",
  "tier_unset",
] as const;
export type Tier = (typeof TIER_VALUES)[number];

export const POOL_VALUES = [
  "interactive",
  "ops",
  "build",
  "explore",
  "pool_unset",
] as const;
export type Pool = (typeof POOL_VALUES)[number];

export const AGENT_VALUES = [
  "director",
  "developer",
  "admin",
  "chat",
  "triage",
  "sprint",
  "bookie",
  "agent_unset",
] as const;
export type Agent = (typeof AGENT_VALUES)[number];
