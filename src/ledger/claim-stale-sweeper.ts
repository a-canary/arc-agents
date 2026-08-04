// Reset stale claims back to ready. A claim is stale if:
//   - claimed_at is older than `staleAfterSec` (default 7200 = 2hr), OR
//   - claimed_by matches `arctest-*` and claimed_at is older than
//     `arctestStaleAfterSec` (default 300 = 5min), OR
//   - it's an orphan: state='claimed' but claimed_by IS NULL or claimed_at IS NULL.
// The 2hr threshold is justified by ~1hr starlight-slm training jobs.
// The tighter arctest threshold: test sessions are unit tests; they should
// never legitimately hold a claim past a test runtime. Leaked arctest claims
// would otherwise block real work for 2hr each, multiplied by however many
// arctest harnesses crashed without releasing.
// Orphan claims indicate a buggy write that bypassed the atomic claim path;
// they can't be caught by the age check (`NULL < N` is false in SQL), so
// they accumulate forever until cleaned up explicitly.

import type { Database } from "bun:sqlite";

// Defaults from docs/decisions/claim-stale-sweeper-cooldown.md. Live-tunable
// via ARC_SWEEPER_COOLDOWN_MAX / ARC_SWEEPER_COOLDOWN_WINDOW_SEC. Read lazily so
// the test suite can mutate process.env between cases.
function cooldownMaxDefault(): number {
  return parseInt(process.env.ARC_SWEEPER_COOLDOWN_MAX ?? "10", 10);
}
function cooldownWindowDefault(): number {
  return parseInt(process.env.ARC_SWEEPER_COOLDOWN_WINDOW_SEC ?? "3600", 10);
}

export type SweepOptions = {
  staleAfterSec?: number;
  arctestStaleAfterSec?: number;
  cooldownMax?: number;
  cooldownWindowSec?: number;
  now?: number; // unix seconds, defaults to current time
};

export type SweepResult = {
  reset: number;
  ids: string[];
  cooldownExcluded: string[]; // row ids that hit the sweeper cooldown (>=N reclaims in window)
};

export function sweepStaleClaims(db: Database, opts: SweepOptions = {}): SweepResult {
  const staleAfterSec = opts.staleAfterSec ?? 7200;
  const arctestStaleAfterSec = opts.arctestStaleAfterSec ?? 300;
  const cooldownMax = opts.cooldownMax ?? cooldownMaxDefault();
  const cooldownWindowSec = opts.cooldownWindowSec ?? cooldownWindowDefault();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const cutoff = now - staleAfterSec;
  const arctestCutoff = now - arctestStaleAfterSec;
  const cooldownCutoff = now - cooldownWindowSec;

  // Pull all stale candidates first, then filter out the ones in sweeper
  // cooldown. We resolve the exclusion list from these stale candidates so a
  // runaway row that's already claimed cannot starve another healthy row from
  // the sweep — only the runaway is excluded.
  const staleRaw = db
    .query<{ id: string; claimed_by: string | null; claimed_at: number | null }, [number, number]>(
      `SELECT id, claimed_by, claimed_at FROM issues
       WHERE state='claimed'
         AND (claimed_at IS NULL
              OR claimed_by IS NULL
              OR claimed_at < ?
              OR (claimed_by LIKE 'arctest-%' AND claimed_at < ?))`,
    )
    .all(cutoff, arctestCutoff);

  // Cooldown: a row whose sweeper-generated reclaim events in the trailing
  // window have hit cooldownMax. Group by issue_id, only count events the
  // sweeper itself emitted (kind='reclaimed' AND agent='claim-stale-sweeper').
  // Param order: cooldownCutoff (ts>=), then candidate ids (IN list), then
  // cooldownMax (HAVING threshold). Must match placeholder order in SQL.
  const cooldownParams: (number | string)[] = [cooldownCutoff];
  for (const r of staleRaw) cooldownParams.push(r.id);
  cooldownParams.push(cooldownMax);
  const cooldownHits = db
    .query<{ issue_id: string; n: number }, (number | string)[]>(
      `SELECT issue_id, COUNT(*) AS n
         FROM issue_events
        WHERE kind='reclaimed' AND agent='claim-stale-sweeper' AND ts >= ?
              AND issue_id IN (${
                staleRaw.length === 0 ? "SELECT '' WHERE 0" : staleRaw.map(() => "?").join(",")
              })
        GROUP BY issue_id
       HAVING COUNT(*) >= ?`,
    )
    .all(...(cooldownParams as (number | string)[]));
  const inCooldown = new Set(cooldownHits.map((c) => c.issue_id));
  const cooldownExcluded = cooldownHits.map((c) => c.issue_id);
  const stale = staleRaw.filter((r) => !inCooldown.has(r.id));

  if (stale.length === 0 && cooldownHits.length === 0) {
    return { reset: 0, ids: [], cooldownExcluded };
  }

  const ids = stale.map((r) => r.id);

  // Batch the "already noted this window?" check instead of one SELECT COUNT
  // per cooldown-hit row (N+1). Single grouped query, same dedup semantics.
  let alreadyNoted = new Set<string>();
  if (cooldownHits.length > 0) {
    const notedRows = db
      .query<{ issue_id: string }, (string | number)[]>(
        `SELECT DISTINCT issue_id FROM issue_events
          WHERE kind='note' AND agent='claim-stale-sweeper' AND ts >= ?
                AND issue_id IN (${cooldownHits.map(() => "?").join(",")})`,
      )
      .all(cooldownCutoff, ...cooldownHits.map((c) => c.issue_id));
    alreadyNoted = new Set(notedRows.map((r) => r.issue_id));
  }

  db.transaction(() => {
    // First-skip-per-window note: when a row hits the cooldown for the first
    // time in this trailing window, write a kind='note' event so the exclusion
    // is auditable. Subsequent skips within the same window do NOT emit (would
    // just be noise; the next skip-first resets the window).
    for (const c of cooldownHits) {
      if (!alreadyNoted.has(c.issue_id)) {
        db.run(
          `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'claim-stale-sweeper', ?)`,
          [c.issue_id, `sweeper cooldown: row ${c.issue_id} excluded (${c.n} reclaims in last ${cooldownWindowSec}s)`],
        );
      }
    }
    for (const r of stale) {
      const orphan = r.claimed_at == null || r.claimed_by == null;
      const arctest = !orphan && r.claimed_by != null && r.claimed_by.startsWith("arctest-");
      const who = r.claimed_by ?? "unknown";
      const ageHr = orphan ? 0 : (now - (r.claimed_at as number)) / 3600;
      const reason = orphan
        ? `orphan claim reset (claimed_by=${r.claimed_by ?? "NULL"}, claimed_at=${r.claimed_at ?? "NULL"})`
        : arctest
          ? `arctest zombie claim by ${who} reset after ${ageHr.toFixed(2)}hr`
          : `stale claim by ${who} reset after ${ageHr.toFixed(1)}hr`;
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

  return { reset: ids.length, ids, cooldownExcluded };
}
