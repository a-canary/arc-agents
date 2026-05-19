// Priority order over (hitl, urgency). Used by claim SQL to pick the next row
// and by /triage-failed when deciding what to spawn.
//
// ADR 0005 §4 — `type` column is gone. Priority is now derived from:
//   - urgency='interactive' wins outright (a user is actively waiting)
//   - hitl=1 next (human-decidable work units; not synchronous but high-signal)
//   - urgency='nominal' is the default bulk
//   - urgency='deferred' is the bottom
//
// Kept the same public surface (typeRank, compareByTypeThenId, TYPE_PRIORITY_SQL)
// for blast-radius reasons, even though the name `typeRank` is now a bit of a
// misnomer. Treated as a single rank function over a row's (hitl, urgency).

import type { Urgency } from "./bookie-validator";

export type RankInput = { urgency: Urgency | string; hitl?: number };

export function rowRank(r: RankInput): number {
  const urg = r.urgency;
  const hitl = r.hitl ?? 0;
  if (urg === "interactive") return 0;
  if (hitl === 1) return 1;
  if (urg === "nominal") return 2;
  if (urg === "deferred") return 3;
  return 999;
}

// Back-compat alias kept so callers don't all need rewriting in this slice.
// Treats string as urgency; no hitl signal available.
export function typeRank(t: string): number {
  return rowRank({ urgency: t });
}

export function compareByTypeThenId(
  a: { urgency: string; hitl?: number; id: string },
  b: { urgency: string; hitl?: number; id: string },
): number {
  const r = rowRank(a) - rowRank(b);
  if (r !== 0) return r;
  return a.id.localeCompare(b.id);
}

// SQL fragment used in ORDER BY for claim queries. CASE over (urgency, hitl)
// so it works in SQLite without a CTE.
export const TYPE_PRIORITY_SQL = `
  CASE
    WHEN urgency='interactive' THEN 0
    WHEN hitl=1 THEN 1
    WHEN urgency='nominal' THEN 2
    WHEN urgency='deferred' THEN 3
    ELSE 999
  END
`;
