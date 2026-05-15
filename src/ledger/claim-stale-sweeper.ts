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
    .query<{ id: string }, [number]>(
      `SELECT id FROM issues WHERE state='claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`,
    )
    .all(cutoff);

  if (stale.length === 0) return { reset: 0, ids: [] };

  const ids = stale.map((r) => r.id);

  db.transaction(() => {
    for (const id of ids) {
      db.run(
        `UPDATE issues SET state='ready', claimed_by=NULL, claimed_at=NULL, updated_at=strftime('%s','now') WHERE id=?`,
        [id],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'claim-stale-sweeper', ?)`,
        [id, `claim reset: stale > ${staleAfterSec}s`],
      );
    }
  })();

  return { reset: ids.length, ids };
}
