// Single-sourced atomic claim. Per ADR 0001 §"Consequences" and G-0002,
// the claim is one SQL `UPDATE...RETURNING` that decides the winner; losers
// see zero rows. This module is the canonical home for that SQL.
//
// Two callers:
//   1. bin/ledger.ts `claim` verb — imports `claimOnce` directly.
//   2. bin/worker-shell.sh (bash bootstrap, no agent process exists yet) —
//      shells out to `ledger print-claim-sql` and pipes the text to sqlite3.
//      ADR 0001 §"Why not alternatives" preserves the bash entrypoint, so
//      we can't collapse the two callers, but we can collapse the SQL.

import type { Database } from "bun:sqlite";
import { SORT_KEY_SQL } from "./tier-pool-sort";
import { CLAIMABLE_KINDS_SQL } from "./kinds";

export type ClaimRow = { id: string };

// Build the canonical claim SQL. With `poolFilter=true`, the inner SELECT
// gains `AND pool=?2` so the fast-pass pool can restrict the claim to one
// pool lane without burning a reserved slot on backlog work.
//
// Bound params: `?1` = worker name; `?2` = pool (only when poolFilter=true).
export function buildClaimSQL(poolFilter: boolean): string {
  const poolClause = poolFilter ? "AND pool=?2 " : "";
  return `UPDATE issues SET state='claimed', claimed_by=?1, claimed_at=strftime('%s','now')
         WHERE id=(SELECT id FROM issues WHERE state='ready' AND kind IN (${CLAIMABLE_KINDS_SQL}) ${poolClause}ORDER BY ${SORT_KEY_SQL} LIMIT 1)
         RETURNING id`;
}

// Canonical claim SQL (no pool filter). Exported as a convenience for
// callers that don't need the fast-pass variant.
export const CLAIM_SQL: string = buildClaimSQL(false);

export function claimOnce(
  db: Database,
  worker: string,
  poolFilter?: string,
): ClaimRow | null {
  if (poolFilter !== undefined) {
    const sql = buildClaimSQL(true);
    return (
      db.query<ClaimRow, [string, string]>(sql).get(worker, poolFilter) ?? null
    );
  }
  return db.query<ClaimRow, [string]>(CLAIM_SQL).get(worker) ?? null;
}
