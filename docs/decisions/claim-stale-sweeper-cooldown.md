# Decision: claim-stale-sweeper cooldown — global per-row threshold

**Date:** 2026-07-11
**Status:** accepted (decision only; implementation is the follow-up row)
**Row:** `director-pick-claim-stale-sweeper-cooldo`
**Evidence:** `~/vault/agents/director/journal/decision-claim-stale-sweeper-cooldown.md`,
`~/vault/agents/director/journal/analysis-1783764179.md` Pattern 2

---

## TL;DR

Pick **(B) global per-row threshold**: at every sweeper pass (`reapOrphanClaims`
+ `sweepStaleClaims`), skip rows where the trailing-window count of
`kind='reclaimed' AND agent='claim-stale-sweeper'` events exceeds threshold.
Initial values: **`>=10 reclaims in last 1h`**. First skip per window per row
emits a `kind='note'` event so the exclusion is auditable.

Rejected: **(A) per-row recent-failure counter** (skip rows with `>=3 failures in last 30min`).
The reason it's the wrong shape is below.

## Why (B), not (A)

The runaway loop observed in `analysis-1783764179.md` Pattern 2 (4 rows,
13,687 reclaim cycles in 5d, ~6s/cycle) is driven by `reapOrphanClaims` in
`src/factory/worker-lifecycle.ts:89-117`, NOT by `sweepStaleClaims`. The
cycle on each iteration:

1. Factory spawns worker; worker claims row via atomic UPDATE.
2. Worker's `claude` engine exits with `rc=141` (SIGPIPE — Pattern 1 root cause)
   within seconds; tmux session dies.
3. `reapOrphanClaims` next tick sees `state='claimed', claimed_by=arc-worker-X,
   tmux session gone` → resets to `ready`, emits `kind='reclaimed'` event.
4. Factory respawns worker. **GOTO 1.**

The row NEVER enters `state='failed'`. The atomic write is `claimed → ready`,
not `claimed → failed`. So a "per-row recent-failure counter" against
`kind='failed'` events would always see zero between cycles, regardless of
how many times the row has cycled. To make (A) work you'd have to retrofit a
new event-kind write into the orphan-reclaim path — same SQL pattern as (B)
just with an artificially narrow filter.

(B) reuses the existing signal: both `reapOrphanClaims` and `sweepStaleClaims`
already write `kind='reclaimed' AND agent='claim-stale-sweeper'` events. One
subquery added to both passes — `WHERE id NOT IN (SELECT issue_id FROM
issue_events WHERE kind='reclaimed' AND agent='claim-stale-sweeper' AND ts >= ?
GROUP BY issue_id HAVING COUNT(*) >= ?)` — gates the reset.

Estimated diff: **≤30 LOC** across `src/ledger/claim-stale-sweeper.ts` +
`src/factory/worker-lifecycle.ts` + 2 test cases.

## Threshold derivation

From `analysis-1783764179.md` Pattern 2 evidence (all rows exceeded
`600 reclaims/hour` ≈ 10/min sustained during the runaway):

- `000165-hygiene-starlight-slm-trash-retired-file`: 9553 reclaims / 15.6h
- `add-the-machine-submitter-denylist-const`: 1533 / 2.5h
- `apply-the-same-exclusion-to-the-projects`: 1465 / 2.5h
- `verify-the-auto-oversight-skill-stamps-t`: 1136 / 2.5h

**`>=10 in last 1h`** (≈ 0.17/min) catches every runaway while leaving single
one-off stale sweeps unconstrained. If a real row has 10 reclaims in an
hour, the operator wants to see it skipped anyway — it's broken.

## Cross-references

- `analysis-1783764179.md` Pattern 1 — same root cause (engine can't advance
  rows); the cooldown absorbs the SYMPTOM until the engine-lifecycle fix
  removes the CAUSE.
- `analysis-1782770508.md` Pattern 1 — structurally identical prior dedup
  recommendation that was lost to a worktree-destruction incident. This row
  is its durable replacement.
- SKILL.md shortlist (commit c74fdf6, PR #320) — new entry references this
  decision.

## Out of scope for this decision

- Engine-lifecycle fix (Pattern 1) — separate work already in flight as
  `alias-cmdline-ownership-registry-driven-`.
- Auto-`cancelled` decision on excluded rows. The guard makes the loop
  survivable; the operator still decides when to cancel.

## Implementation handoff

Implementation row to be filed by `hygiene-emit` immediately after this row
merges. Scope (≤30 LOC + 2 tests):

1. Add `SweeperCooldownOptions` to `sweepStaleClaims`:
   `cooldownMax?: number` (default `10`),
   `cooldownWindowSec?: number` (default `3600`).
2. Same options added to `reapOrphanClaims`.
3. First skip per window per row writes a `kind='note'` event
   (`sweeper cooldown: row X excluded (N reclaims in last 1h)`).
4. `factory --metrics` prints `sweeper_cooldown_excluded` count + row ids.
5. Env knobs: `ARC_SWEEPER_COOLDOWN_MAX`, `ARC_SWEEPER_COOLDOWN_WINDOW_SEC`.
