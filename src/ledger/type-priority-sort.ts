// Priority order for `type`. HITL is first (highest priority), deferred last.
// Used by claim SQL to pick the next row and by /triage-failed when deciding
// what to spawn.

import type { Type } from "./bookie-validator";

// `interactive` ranks above HITL: user is actively waiting on the next chat
// reply, prefetch, or UX response. HITL is for human-decidable work units
// (taste/impact) but does not imply synchronous waiting.
export const TYPE_PRIORITY: Record<Type, number> = {
  interactive: 0,
  HITL: 1,
  cron: 2,
  mvp: 3,
  security: 4,
  quality: 5,
  scale: 6,
  efficiency: 7,
  deferred: 8,
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
    WHEN 'interactive' THEN 0
    WHEN 'HITL' THEN 1
    WHEN 'cron' THEN 2
    WHEN 'mvp' THEN 3
    WHEN 'security' THEN 4
    WHEN 'quality' THEN 5
    WHEN 'scale' THEN 6
    WHEN 'efficiency' THEN 7
    WHEN 'deferred' THEN 8
    ELSE 999
  END
`;
