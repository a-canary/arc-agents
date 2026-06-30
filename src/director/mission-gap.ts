/**
 * Mission-gap proposer (pure deep module — PRD slice 7).
 *
 * Maps mission goals against ledger work to surface goals that have NO active
 * or completed work linked to them. A runaway Director must not originate
 * unbounded speculative work, so the output is capped (user-story 14).
 *
 * Pure: no I/O, no Date/Math/console, no classes. Trivial interface; the
 * coverage + budget logic is the encapsulated complexity.
 */

export interface MissionGoal {
  id: string;
  title: string;
}

/** A ledger issue row, minimal shape this module needs. */
export interface LedgerRow {
  goalId?: string;
  state: string;
}

export interface Gap {
  goalId: string;
  title: string;
  reason: string;
}

/** States that count as coverage — active or completed work linked to a goal. */
const COVERING_STATES = new Set([
  "ready",
  "claimed",
  "wip",
  "review",
  "blocked",
  "merged",
]);

const DEFAULT_MAX_PROPOSALS = 5;

const REASON_NO_WORK = "no active ledger work linked to this goal";
const REASON_DEAD_WORK = "only cancelled/failed work linked to this goal";

export function gaps(
  missionGoals: MissionGoal[],
  ledgerState: LedgerRow[],
  opts?: { maxProposals?: number },
): Gap[] {
  const requested = opts?.maxProposals;
  // Negative/undefined cap → default; cap of 0 is honored (returns []).
  const cap =
    requested === undefined || requested < 0 ? DEFAULT_MAX_PROPOSALS : requested;

  if (cap === 0) return [];

  // Per-goal coverage flags: linked (any row) and covered (any covering row).
  const linked = new Set<string>();
  const covered = new Set<string>();
  for (const r of ledgerState) {
    if (r.goalId === undefined) continue;
    linked.add(r.goalId);
    if (COVERING_STATES.has(r.state)) covered.add(r.goalId);
  }

  const out: Gap[] = [];
  for (const g of missionGoals) {
    if (covered.has(g.id)) continue;
    out.push({
      goalId: g.id,
      title: g.title,
      reason: linked.has(g.id) ? REASON_DEAD_WORK : REASON_NO_WORK,
    });
    if (out.length === cap) break;
  }
  return out;
}
