// Reset stale claims back to ready. A claim is stale if claimed_at is older
// than `staleAfterSec` (default 7200 = 2hr). Justified by ~1hr starlight-slm
// training jobs; >2hr means the worker hung or died mid-task.
//
// Pure-ish: takes a Database, but the logic is a single SQL statement with
// the threshold as a parameter, so tests can inject a synthetic "now".

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
      `SELECT id, claimed_by, claimed_at FROM issues WHERE state='claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`,
    )
    .all(cutoff);

  if (stale.length === 0) return { reset: 0, ids: [] };

  const ids = stale.map((r) => r.id);

  db.transaction(() => {
    for (const r of stale) {
      const ageSec = r.claimed_at != null ? now - r.claimed_at : staleAfterSec;
      const ageHr = (ageSec / 3600).toFixed(1);
      const who = r.claimed_by ?? "unknown";
      db.run(
        `UPDATE issues SET state='ready', claimed_by=NULL, claimed_at=NULL, updated_at=strftime('%s','now') WHERE id=?`,
        [r.id],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'reclaimed', 'claim-stale-sweeper', ?)`,
        [r.id, `stale claim by ${who} reset after ${ageHr}hr`],
      );
    }
  })();

  return { reset: ids.length, ids };
}
