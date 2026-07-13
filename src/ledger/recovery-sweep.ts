// Recovery sweep: read blocked rows whose evidence carries the
// `engine-alias-no-work:<alias>` marker (emitted by worker-shell.sh's final
// reconcile branch — d1f9ae3), group by alias, probe each alias with a
// trivial command, and on probe success (rc=0) flip every row for that
// alias back to `ready`. Alias still starved → rows stay blocked, no
// state change. One event per flipped row, one summary event per probe.
// Pure module: probe is injected so tests can stub it. See
// engine-alias-no-work-recovery-sweep-one-.

import type { Database } from "bun:sqlite";

const MARKER_RE = /engine-alias-no-work:([A-Za-z0-9_-]+)/g;

export type ProbeResult = { rc: number; stdout: string };
export type Probe = (command: string) => ProbeResult;

export type RecoverySweepOptions = {
  now?: number;
  probe: Probe;
  commandFor: (alias: string) => string;
};

export type ProbeSummary = {
  alias: string;
  rc: number;
  recovered: boolean;
  flipped: number;
  kept: number;
};

export type RecoverySweepResult = {
  flipped: string[];        // ids transitioned blocked → ready
  kept: string[];           // ids that stayed blocked (probe failed / empty)
  skipped: string[];        // ids that didn't match the filter at all
  probes: ProbeSummary[];   // one per distinct alias probed
};

// Defensive guard: aliases are [A-Za-z0-9_-]+. If a row's evidence has
// anything else after the marker (e.g. a stray space, a sentence), we still
// pick up the first valid chunk. This avoids the regex blowing past bad
// evidence text into unrelated content.
function extractAlias(evidence: string | null): string | null {
  if (!evidence) return null;
  MARKER_RE.lastIndex = 0;
  const m = MARKER_RE.exec(evidence);
  return m ? m[1]! : null;
}

export function sweepRecovery(
  db: Database,
  opts: RecoverySweepOptions,
): RecoverySweepResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const { probe, commandFor } = opts;

  // 1. Pull all blocked rows. We filter in JS, not SQL, because we need
  //    the alias extracted from evidence — a regex on TEXT is fine but
  //    keeping it here lets the stub-tests reuse the same logic.
  const blockedRows = db
    .query<{ id: string; evidence_md: string | null }, []>(
      `SELECT id, evidence_md FROM issues WHERE state='blocked'`,
    )
    .all();

  const byAlias = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const row of blockedRows) {
    const alias = extractAlias(row.evidence_md);
    if (!alias) {
      skipped.push(row.id);
      continue;
    }
    const list = byAlias.get(alias) ?? [];
    list.push(row.id);
    byAlias.set(alias, list);
  }

  // 2. For each distinct alias: probe once, then flip-or-keep.
  const probes: ProbeSummary[] = [];
  const flipped: string[] = [];
  const kept: string[] = [];

  for (const [alias, ids] of byAlias) {
    const cmd = commandFor(alias);
    let result: ProbeResult;
    try {
      result = probe(cmd);
    } catch (e) {
      // Probe blew up (alias unknown to resolver, exec failed). Treat as
      // starved: leave rows alone, record the failure so the operator can
      // see what happened.
      result = { rc: 127, stdout: e instanceof Error ? e.message : String(e) };
    }
    const recovered = result.rc === 0;
    const affected = recovered ? ids : [];
    if (!recovered) kept.push(...ids);

    // 3. Atomic flip + per-row audit event + per-alias summary event.
    db.transaction(() => {
      for (const id of affected) {
        db.run(
          `UPDATE issues SET state='ready', updated_at=strftime('%s','now') WHERE id=?`,
          [id],
        );
        db.run(
          `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'unblocked', 'recovery-sweep', ?)`,
          [id, `recovery-sweep: alias=${alias} probe_rc=0; flipped blocked→ready`],
        );
      }
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'recovery-sweep', ?)`,
        [
          affected[0] ?? ids[0]!, // pin the summary to a real row so the audit trail survives even on zero flips
          `recovery-sweep probe: alias=${alias} rc=${result.rc} stdout_bytes=${result.stdout.length} flipped=${affected.length} kept=${ids.length - affected.length}`,
        ],
      );
    })();

    probes.push({
      alias,
      rc: result.rc,
      recovered,
      flipped: affected.length,
      kept: ids.length - affected.length,
    });
    flipped.push(...affected);
  }

  return { flipped, kept, skipped, probes };
}