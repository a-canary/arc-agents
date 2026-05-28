// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// Migration 017 — tier-MAJOR / pool-MINOR sort key.
// Replaces class-urgency-sort.ts for post-017 tables.
// tier picks priority rank; pool picks worker-lane; created_at is FIFO tiebreak; id is final stable tiebreak.

// ADR 0005 enums owned by schema-enums.ts. Re-exported here so callers of
// tier-pool-sort keep working without additional imports.
export { TIER_VALUES, POOL_VALUES } from "./schema-enums";
export type { Tier, Pool } from "./schema-enums";
import type { Tier, Pool } from "./schema-enums";

export const TIER_RANK: Record<Tier, number> = {
  prod: 0,
  trust: 1,
  mvp: 2,
  quality: 3,
  scale: 4,
  efficiency: 5,
  hygiene: 6,
  tier_unset: 99,
};

export const POOL_RANK: Record<Pool, number> = {
  interactive: 0,
  ops: 1,
  build: 2,
  explore: 3,
  pool_unset: 99,
};

export function tierRank(t: Tier | string): number {
  return TIER_RANK[t as Tier] ?? 999;
}

export function poolRank(p: Pool | string): number {
  return POOL_RANK[p as Pool] ?? 999;
}

export type SortRow = {
  id: string;
  tier: string;
  pool: string;
  created_at: number;
};

export function sortKey(r: SortRow): [number, number, number, string] {
  return [tierRank(r.tier), poolRank(r.pool), r.created_at, r.id];
}

export function compareBySortKey(a: SortRow, b: SortRow): number {
  const t = tierRank(a.tier) - tierRank(b.tier);
  if (t !== 0) return t;
  const p = poolRank(a.pool) - poolRank(b.pool);
  if (p !== 0) return p;
  const c = a.created_at - b.created_at;
  if (c !== 0) return c;
  return a.id.localeCompare(b.id);
}

// SQL fragments for ORDER BY. Materialized as CASE so they work in SQLite
// without a CTE. Compose as `ORDER BY ${TIER_RANK_SQL}, ${POOL_RANK_SQL}, created_at, id`.
export const TIER_RANK_SQL = `
  CASE tier
    WHEN 'prod'       THEN 0
    WHEN 'trust'      THEN 1
    WHEN 'mvp'        THEN 2
    WHEN 'quality'    THEN 3
    WHEN 'scale'      THEN 4
    WHEN 'efficiency' THEN 5
    WHEN 'hygiene'    THEN 6
    WHEN 'tier_unset' THEN 99
    ELSE 999
  END
`;

export const POOL_RANK_SQL = `
  CASE pool
    WHEN 'interactive' THEN 0
    WHEN 'ops'         THEN 1
    WHEN 'build'       THEN 2
    WHEN 'explore'     THEN 3
    WHEN 'pool_unset'  THEN 99
    ELSE 999
  END
`;

export const SORT_KEY_SQL = `${TIER_RANK_SQL}, ${POOL_RANK_SQL}, created_at, id`;
