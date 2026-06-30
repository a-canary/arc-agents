# ADR 0008 — Vast.ai Operator Pattern (Worker Lands the Finding, Operator Runs the Compute)

**Status:** Accepted — 2026-06-05
**Supersedes:** nothing. Refines ADR 0001 by carving out a documented *operator role* for tasks whose deliverable is GPU compute, leaving the worker as a "land-the-finding" role.
**Related:** analysis report `~/vault/agents/director/journal/analysis-1780697137.md` (Pattern 3, 4 evidence rows + 7 eventually-successful evidence rows + the E4 operator-note 2026-05-30 15:28:54).

## Context

ADR 0001 established that workers are ephemeral and atomic-claim tasks from the ledger. The factory boots a fresh `claude` per task with a 4-hour reap ceiling and a 30-minute stall watchdog. That design assumes *the worker does the work* and writes back to the ledger before either budget fires.

Starlight-slm experiment tasks (LoRA sweeps, embedding passes, N-domain scaling) have a different shape: the deliverable is a multi-hour GPU compute run on a vast.ai 3090 lease. The worker's role on these tasks is to *land the finding* — the operator (a human or a manual script) has already run the compute on the vast box, written the artifacts, and the worker's job is to commit + diff-review + merge the result row. ADR 0001 doesn't explicitly say this is the intended design, and the 30-minute watchdog is a turn-level safety net, not a task-level budget for compute. Without a documented pattern, factory workers for compute tasks run the experiment in the worker's bash, hit the 30-minute watchdog, and `exit 124`.

The data (from `analysis-1780697137.md`, 2026-05-28 → 2026-06-04 window, primary source: `~/vault/ledger.db` events table):

| Pattern | Evidence |
|---|---|
| 4 compute rows merged via the operator path (E3, E9, E10, E13) | merged-event payload explicitly cites "Operator-run GPU experiment", "the actual executor was the vast orchestrator", "zero-GPU" (E13 didn't need vast). Elapsed: 17s – 15 min, all well under the 30-min watchdog. |
| 7 compute rows failed via `exit 124` (E1, E2, E4, E5, E7, E8, 000027-hygiene) | factory worker tried to do the compute in bash, hit the 30-min watchdog at 1800s (±1s SIGTERM lag), 0 commits. The 5 starred rows (E2/E5/E6/E7/000027) all show fail_ts = claim_ts + 1801s — the watchdog is exactly 30 min. |
| All 7 failed rows eventually merged via the operator path | 4 via a fresh worker claiming the revive-→ready row; 3 via bookie's manual revive + operator-run + worker-merge. Operator-path latency: 23 hours (E4) to 99 minutes (E8) — slower than direct, but the work was not lost. |
| 14/21 (67%) of all `exit-124` failures in the last 14 days are ML-compute projects | starlight-slm 10/21, expert-horde 4/21. The watchdog-vs-compute mismatch is a factory-wide issue, not a starlight-slm-specific defect. |

## Decision

**For compute-heavy ML tasks, the operator runs the compute on a vast.ai lease; the factory worker lands the finding. The 30-minute watchdog is a turn-level safety net, not a task-level budget for compute.**

Concretely:

1. **Two roles, one row.** A compute task has two distinct roles in its lifecycle:
   - **Operator** (human or scripted): holds the vast.ai lease via `bun ~/repos/arc-agents/bin/vast-lease.ts acquire --wait`, runs the experiment, writes artifacts (`findings/E<n>.md`, log files, weight checkpoints, KE note), and signals completion by writing to the worktree or by re-issuing the row as `state=ready` if it previously failed.
   - **Worker** (factory): atomic-claims the row, finds the operator's artifacts on disk in the worktree, runs `git add` + `git commit` + diff-review handshake, exits when the merge lands.

2. **The watchdog remains 30 minutes.** It's a turn-level safety net, not a compute budget. The 30-min number is correct for *any single turn* of a worker (LLM thinking, file reads, code edits, commit). It is incorrect for "the worker bash should run a 4-hour training job." The fix is not to raise the watchdog (which would break the turn-level safety property); the fix is to make explicit that compute tasks don't run compute in the worker.

3. **The factory does not need a new state or a new tier.** The revive-→ready transition (bookie's existing `kind=event`) handles the "worker failed → operator ran the compute → row is back to ready" loop. The 30-min watchdog firing is the *correct* signal that a row is "operator-needed, not worker-needed" — the operator sees the failed row, runs the compute, and re-issues.

4. **Compute tasks self-identify via a `tier` field.** A future enhancement (filed as a follow-up, not in this ADR) may add a `tier=compute` flag on compute-heavy rows so the factory can warn at claim-time: "this row is intended for the operator path, you are a worker; expect artifacts on disk and a <30-min commit window." For now, the doc is enough — the operator's hand-off is observable (artifacts exist in the worktree) and the worker's response is observable (commit lands within 30 min of claim).

5. **The factory does not auto-revive `exit-124` rows.** Auto-revive would burn the worker slot again on the same row with the same outcome. The revival is a human-or-bookie call, after the operator has produced artifacts.

## Why not alternatives

**Path (a) — Add a `vast-orchestrator` worker tier that holds the slot for the duration of a vast.ai lease, with a heartbeat.** This is what the task brief offered as option (a). It would let the worker stay alive for 4+ hours and heartbeat to the factory. Rejected because:
- It changes the factory's profile schema, the worker bootstrap, the claim-stale sweeper, and the reaper — all for one project's compute pattern. The factory would carry 3090-lease semantics (TTL, lease-acquire, lease-release) into the worker bootstrap, which is the wrong layer. The lease is a *vast* concern; the factory should be vast-agnostic.
- It does not solve the underlying problem (compute takes longer than 30 min, period). It just lets one tier ignore the watchdog.
- It loses the 4-hour reap ceiling, which is a real safety net for genuinely stuck workers.
- The current pattern already works: the operator holds the lease, the worker holds the slot, the factory's 30-min watchdog is the *clock* that says "your turn is up, hand off to the operator." The clock is useful.

**Path (b) — Add a `needs-vast-orchestrator` factory state that auto-revives failed compute rows when a 3090 lease is free.** This is what the task brief offered as option (b). It would let bookie watch vast-lease availability and revive rows. Rejected because:
- It puts lease-availability into bookie, which should be vast-agnostic (bookie validates ledger state transitions, not external resources).
- Auto-revive would create a tight loop: row fails → factory sees lease free → revives row → worker re-claims → row fails again at watchdog → loop. The operator needs to *do something* between failures (run the compute, write artifacts); auto-revive doesn't give the operator time.
- The "wait for lease, then revive" pattern can be implemented at the operator level (a cron that scans for `exit-124` rows + free lease and emits a revive event) without changing bookie or factory semantics. That belongs in a future skill, not in ADR 0008.

**Path (c) — Document the operator path as the intended design.** Accepted. This is slice-bounded (3 doc edits), evidence-aligned (the 4 successful + 7 eventually-successful rows all used this path), low-risk (docs only), and reversible (a future ADR can introduce a new tier or state if the doc isn't enough).

**Headless `claude -p` for compute tasks.** Rejected per ADR 0001: violates CHOICES.md M-0002 (Max account has extra-usage off; `-p` consumes from the wrong billing bucket). The operator-on-vast + worker-in-factory pattern keeps the worker on the correct billing path.

**Raise the watchdog to 4 hours.** Rejected: breaks the turn-level safety property. A truly stuck worker (LLM API hang, network partition, deadlocked bash) would burn the full 4-hour slot before being reaped. The 30-min number is correct for *turns*; the question is what the *task* should be doing during those turns, and the answer (per this ADR) is *landing the finding*, not *running the compute*.

## Operator pattern (canonical shape)

A compute task's full lifecycle, end-to-end:

```
1. User (or director) files a ledger row: kind=task, type=interactive, body describes
   the experiment (LoRA sweep, embedding pass, N-domain scaling, etc.). The row lands
   at state=ready.

2. Factory worker atomic-claims the row. Worker reads body, sees "this is a compute
   task", looks for operator artifacts in the worktree.

3a. If artifacts exist (operator has run the compute): worker runs git add + commit
   on the artifacts + KE note, then diff-review + merge handshake. Elapsed: 17s – 15
   min. Row lands merged.

3b. If artifacts do NOT exist (operator has not run the compute yet): worker has two
   options:
   - (i) Run the compute in the worker bash. Acceptable for short tasks (<30 min).
     Long tasks will hit the 30-min watchdog and exit 124; the row is correctly
     failed and the operator is now on the hook.
   - (ii) For long tasks, the worker should declare the row needs the operator path
     and exit early with state=blocked and a pointer to the operator's task list.
     The factory will reap the worker (it has nothing to do); the operator sees the
     failed/blocked row and runs the compute.

4. Operator runs the compute on a vast.ai lease:
   $ bun ~/repos/arc-agents/bin/vast-lease.ts acquire --wait
   $ # lease acquired; run experiment; write artifacts to worktree
   $ # lease release on completion (manual or auto on script exit)

5. Operator signals the row is back to ready: writes to worktree AND/OR asks bookie
   to emit a revive event. (bookie revive is the manual-but-tractable path:
   `kind=event payload=revive:<row-id>`.) A fresh worker will then claim the row
   and land the finding.

6. Diff-review + merge. Row lands merged. The deliverable is the operator's KE note
   + the artifacts, not the worker's commit (the commit is a thin wrapper).
```

The 4 successful E-rows (E3, E9, E10, E13) and the 7 eventually-successful E-rows (E1, E2, E4, E5, E7, E8, 000027) all followed this shape. The factory's role is *just* step 3a and 5–6; the operator's role is step 4. The factory's 30-min watchdog is the *signal* that step 3b (i) is not viable for long tasks and the row needs to fall through to step 4.

## Operator-completion hook (Pattern 3)

The lifecycle above assumes the worker is alive when the operator finishes. In the Round-2 capacity probe (`round-2-capacity-probe-execute-full-ft-o`, evidence in `~/vault/agents/director/journal/analysis-1782813826.md` Pattern 3) the worker died 17s after claim (`exit 1, 0 commits`) and was reaped; the actual vast run on box 42453957 SUCCESS'd ~40min later but the row stayed `state=failed` because the factory had no signal that the operator had landed artifacts. The fix is a ledger event the operator fires AFTER the compute lands:

```bash
bun ~/repos/arc-agents/bin/ledger.ts event <row-id> operator_landed \
  '{"artifact_dir":".run-artifacts/round2","receipt_sha256":"...","box_id":"42453957"}'
```

The new `kind=operator_landed` event is added to `issue_events.kind` by migration `026_event_kind_operator_landed` (mirrors the 013/014/018 CHECK-expand pattern). It is purely informational today — no state transition fires on it — but it (a) gives operators an audit trail of when compute landed relative to the worker failure, and (b) sets up a future bookie transition `failed → ready` gated on the presence of an `operator_landed` event for the row (Pattern 3 follow-up; not this slice).

**Worked example — Round-2 timeline with operator_landed:**

| ts (UTC) | event | actor |
|---|---|---|
| 17:24:20 | `claimed` (worker `arc-worker-a-w8aebc`) | factory |
| 17:24:37 | `failed` (`exit 1, 0 commits`) | worker → factory |
| 17:24:40 | worktree reaped | `worktree-reaper` |
| 17:25:00 | (operator notices failed row, launches vast run on box 42453957) | operator |
| 18:04:40 | (compute SUCCESS on box, artifacts in `.run-artifacts/round2/`) | vast box |
| 18:05:00 | **`operator_landed` event** (`artifact_dir=...`, `box_id=42453957`, `receipt_sha256=...`) | operator |
| 18:06:00 | (future: bookie auto-promotes `failed → ready`, fresh worker claims and merges) | factory |

Without the hook, only the first three rows existed — the operator's work was invisible. With the hook, steps 5 and 6 of the canonical shape above become self-documenting even when the worker has been reaped.

## Consequences

**Positive:**
- The 30-min watchdog stays correct for turn-level safety.
- The factory stays vast-agnostic — no lease, no instance-id, no GPU-pool semantics leak into bookie or factory code.
- Compute tasks land via a path that *already works* for 4 + 7 = 11 rows in the window. No new infrastructure needed; the pattern is already in production use.
- The 4-hour reap ceiling stays effective — a worker that genuinely hangs on a compute task is reaped within 4 hours, not the 4+ hours a long task would have needed.
- Slice-bounded: this is a 3-doc change, no code changes. Reversible: a future ADR can introduce a new tier or state if the doc isn't enough.

**Negative / accepted costs:**
- The operator must be awake to run the compute. The factory has no "row is in limbo, please revive" alarm; the operator (or a future cron that scans `exit-124` rows) is the trigger. This is the same as the current brittleness: "if the operator is asleep or busy, the row sits at `state=failed` until the operator notices." Mitigated by the fact that starlight-slm's compute workload runs during operator-active hours (per the experiment cadence in the KE notes).
- A worker that claims a row before the operator has finished the compute will run the 30-min watchdog and fail. The operator's hand-off is observable (artifacts on disk) but not atomic; a 60-120s race window exists where the worker claims before the operator commits the artifacts. This is the same race-claim issue called out in `analysis-1780697137.md` Pattern 4b; the fix there is a factory-side "hold race-claim window for 60-120s after cascade-on-merge," not part of this ADR.
- The "tier=compute" tag (decision §4) is *recommended* but not enforced. A worker claiming a compute row today still has to read the row's body to know it's compute. Future enhancement: bookie adds a `tier=compute` validation that warns the worker at claim-time. Filed for a follow-up.

**Out of scope (filed as follow-up ledger rows, not this ADR):**
- Per-tier watchdog (Pattern 1 from `analysis-1780697137.md`) — the structural fix for the 30-min-vs-compute mismatch is "compute tasks don't run compute in the worker," which is what this ADR documents. A per-tier watchdog would be a *layered* defense, not a substitute.
- Race-claim protection (Pattern 4b from same analysis) — factory-side hold on race-claim window after cascade-on-merge. Independent fix.
- Stale `blocked_by` sweep on revive (Pattern 4a) — bookie-side fix. Independent.
- Worktree-reaper active-process check (Pattern 4c) — factory-side fix. Independent.
- Auto-revive loop guard (Pattern 4b's auto-revive variant) — if/when a cron-based revive tool is built, it must not tight-loop on the same `exit-124` row.

## How we verify this is working

- **Existing signal stays green.** The 4 + 7 = 11 rows that used the operator path continue to merge. A new compute row that hits `exit 124` AND is operator-revived is the expected shape, not a defect.
- **Failure cost is bounded.** A failed compute row that *is not* operator-revived within 24 hours is a stale row; the hygiene cron (`analyse-recent-sessions` skill, wired to a future Slice D) should flag it.
- **The factory stays vast-agnostic.** `git grep -n "vast" bin/ factory.ts worker-shell.sh` should return 0 hits in arc-agents. (Currently 0; this ADR doesn't add any.)
- **The doc is referenced.** The hygiene skill (`skills/analyse-recent-sessions/SKILL.md`) cites this ADR by name in its "deliverable shape" section so that future analyses that surface a "compute-vs-watchdog" pattern point at this ADR as the documented design.

## Cross-references

- ADR 0001 — Ephemeral Workers via Factory. ADR 0008 refines ADR 0001's "the worker does the work" assumption for compute tasks.
- ADR 0004 — Agent Doctrine. Section "Pattern Detection & Root-Cause Discipline" — the 11-row operator-path pattern is the empirical evidence for this ADR.
- `~/vault/agents/director/journal/analysis-1780697137.md` — Pattern 3 (4 successful + 7 eventually-successful) + cross-corroboration in §"Cross-corroboration with prior project analyses" (the trading + dream analyses' "local-only branch with valuable work" cousin).
- `~/vault/ke/projects/starlight-real-data-gauntlet.md` — E45–E50 capstone, all built via the operator-vast-3090 path. The 6 verdicts (entropy-argmin, AURC, defer, etc.) are the empirical evidence that the operator path produces deployable artifacts.
- KE notes `~/vault/ke/projects/starlight-e1..e14-*.md` — per-experiment details; the merged-event payloads carry the "Operator-run GPU experiment" / "vast orchestrator" / "zero-GPU" tags that this ADR formalizes.
