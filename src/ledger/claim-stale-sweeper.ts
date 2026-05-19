// Reset stale claims back to ready. A claim is stale if:
//   - claimed_at is older than `staleAfterSec` (default 7200 = 2hr), OR
//   - it's an orphan: state='claimed' but claimed_by IS NULL or claimed_at IS NULL.
// The 2hr threshold is justified by ~1hr starlight-slm training jobs.
// Orphan claims indicate a buggy write that bypassed the atomic claim path;
// they can't be caught by the age check (`NULL < N` is false in SQL), so
// they accumulate forever until cleaned up explicitly.

import type { Database } from "bun:sqlite";

export type SweepOptions = {
  staleAfterSec?: number;
  now?: number; // unix seconds, defaults to current time
};

export type SweepResult = {
  reset: number;
  ids: string[];
};

export function sweepStaleClaims(db: Database, opts: SweepOptions = {}): SweepResult {
  const staleAfterSec = opts.staleAfterSec ?? 7200;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const cutoff = now - staleAfterSec;

  const stale = db
    .query<{ id: string; claimed_by: string | null; claimed_at: number | null }, [number]>(
      `SELECT id, claimed_by, claimed_at FROM issues
       WHERE state='claimed'
         AND (claimed_at IS NULL OR claimed_by IS NULL OR claimed_at < ?)`,
    )
    .all(cutoff);

  if (stale.length === 0) return { reset: 0, ids: [] };

  const ids = stale.map((r) => r.id);

  db.transaction(() => {
    for (const r of stale) {
      const orphan = r.claimed_at == null || r.claimed_by == null;
      const who = r.claimed_by ?? "unknown";
      const reason = orphan
        ? `orphan claim reset (claimed_by=${r.claimed_by ?? "NULL"}, claimed_at=${r.claimed_at ?? "NULL"})`
        : `stale claim by ${who} reset after ${((now - (r.claimed_at as number)) / 3600).toFixed(1)}hr`;
      db.run(
        `UPDATE issues SET state='ready', claimed_by=NULL, claimed_at=NULL, updated_at=strftime('%s','now') WHERE id=?`,
        [r.id],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'reclaimed', 'claim-stale-sweeper', ?)`,
        [r.id, reason],
      );
    }
  })();

  return { reset: ids.length, ids };
}
