// Priority order for `type`. HITL is first (highest priority), deferred last.
// Used by claim SQL to pick the next row and by /triage-failed when deciding
// what to spawn.

import type { Type } from "./bookie-validator";

export const TYPE_PRIORITY: Record<Type, number> = {
  HITL: 0,
  cron: 1,
  mvp: 2,
  security: 3,
  quality: 4,
  scale: 5,
  efficiency: 6,
  deferred: 7,
};

export function typeRank(t: Type | string): number {
  return TYPE_PRIORITY[t as Type] ?? 999;
}

export function compareByTypeThenId(a: { type: string; id: string }, b: { type: string; id: string }): number {
  const r = typeRank(a.type) - typeRank(b.type);
  if (r !== 0) return r;
  return a.id.localeCompare(b.id);
}

// SQL fragment used in ORDER BY for claim queries. Materialized as CASE so
// it works in SQLite without a CTE.
export const TYPE_PRIORITY_SQL = `
  CASE type
    WHEN 'HITL' THEN 0
    WHEN 'cron' THEN 1
    WHEN 'mvp' THEN 2
    WHEN 'security' THEN 3
    WHEN 'quality' THEN 4
    WHEN 'scale' THEN 5
    WHEN 'efficiency' THEN 6
    WHEN 'deferred' THEN 7
    ELSE 999
  END
`;
