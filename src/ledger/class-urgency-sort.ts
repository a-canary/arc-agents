// ADR 0005 — claim/spawn sort key. Two orthogonal axes plus created_at tiebreak.
// `urgency` picks slot eligibility (interactive vs backlog); `class` picks
// within-urgency priority; `created_at` is FIFO tiebreak; `id` is final
// stable tiebreak.

export const URGENCY_VALUES = ["interactive", "nominal", "deferred"] as const;
export type Urgency = (typeof URGENCY_VALUES)[number];

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

export const URGENCY_RANK: Record<Urgency, number> = {
  interactive: 0,
  nominal: 1,
  deferred: 2,
};

export const CLASS_RANK: Record<Class, number> = {
  BUG: 0,
  MVP: 1,
  ops: 2,
  hygiene: 3,
  quality: 4,
  trust: 5,
  scale: 6,
  efficiency: 7,
  class_unset: 99,
};

export function urgencyRank(u: Urgency | string): number {
  return URGENCY_RANK[u as Urgency] ?? 999;
}

export function classRank(c: Class | string): number {
  return CLASS_RANK[c as Class] ?? 999;
}

export type SortRow = {
  id: string;
  class: string;
  urgency: string;
  created_at: number;
};

export function sortKey(r: SortRow): [number, number, number, string] {
  return [urgencyRank(r.urgency), classRank(r.class), r.created_at, r.id];
}

export function compareBySortKey(a: SortRow, b: SortRow): number {
  const u = urgencyRank(a.urgency) - urgencyRank(b.urgency);
  if (u !== 0) return u;
  const c = classRank(a.class) - classRank(b.class);
  if (c !== 0) return c;
  const t = a.created_at - b.created_at;
  if (t !== 0) return t;
  return a.id.localeCompare(b.id);
}

// SQL fragments for ORDER BY. Materialized as CASE so they work in SQLite
// without a CTE. Compose as `ORDER BY ${URGENCY_RANK_SQL}, ${CLASS_RANK_SQL}, created_at, id`.
export const URGENCY_RANK_SQL = `
  CASE urgency
    WHEN 'interactive' THEN 0
    WHEN 'nominal' THEN 1
    WHEN 'deferred' THEN 2
    ELSE 999
  END
`;

export const CLASS_RANK_SQL = `
  CASE class
    WHEN 'BUG' THEN 0
    WHEN 'MVP' THEN 1
    WHEN 'ops' THEN 2
    WHEN 'hygiene' THEN 3
    WHEN 'quality' THEN 4
    WHEN 'trust' THEN 5
    WHEN 'scale' THEN 6
    WHEN 'efficiency' THEN 7
    WHEN 'class_unset' THEN 99
    ELSE 999
  END
`;

export const SORT_KEY_SQL = `${URGENCY_RANK_SQL}, ${CLASS_RANK_SQL}, created_at, id`;
