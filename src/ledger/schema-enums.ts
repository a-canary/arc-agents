// ADR 0005 — single source of truth for the (class, urgency) enum pair.
// Both `class-urgency-sort.ts` and `bookie-validator.ts` re-export from here so
// the SQL CHECK list, the runtime validators, and the comparator's RANK maps
// cannot drift. Migration 011 also generates its CHECK lists from these arrays
// (see `migrate.ts` 011_class_urgency_schema).

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
