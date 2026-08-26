# ADR 0014 — First-class ledger control verbs: `wake`, `await`, `cancel`, `inspect`

**Status:** accepted (2026-08-25)
**Date:** 2026-08-25
**Decides:** Whether the arc-agents ledger CLI grows four first-class control verbs (`wake`, `await`, `cancel`, `inspect`) with defined exit codes, and what their exact semantics are.

---

## Context

Agents today drive ledger state with a patchwork of indirect mechanisms:

- **Waiting** — `wait-for-ledger.ts` polls for *claimable rows* (kind-level), not for a
  specific row's terminal state or barrier pass. A worker blocked on one child has no
  first-class "block until that child resolves" primitive; it hand-rolls sleep loops or
  relies on the factory to re-dispatch.
- **Unblocking** — `ledger tick` is a global backstop sweep (cascade-unblock + stale
  reclaim). A worker that just merged a blocker cannot re-evaluate *its own parent*
  without running a whole-ledger sweep; and when recovery-sweep flips a row
  blocked→ready on an engine-alias probe, there is no targeted verb to do the same for
  one row.
- **Cancellation** — cancelling a row means `update --state cancelled` with ad-hoc
  evidence, and dependents are left silently blocked forever (tick's arm 1 requires ALL
  blockers merged). No event tells a dependent "your blocker was cancelled, not merged".
- **Observability** — to see what a claimed worker is doing, an operator hand-runs
  `tmux capture-pane` against the guessed session name. Nothing in the CLI resolves
  row → live tmux session.

The ledger is the message bus (ADR 0001/0003); control flow over it should be a first-class
CLI surface with stable exit codes, not shell folklore.

## Decision

**Decision 1: Four verbs in `bin/ledger.ts`, one test file each.**

| Verb | Shape | Mutates? | Exit codes |
| --- | --- | --- | --- |
| `wake <id>` | targeted unblock re-eval | yes (state + event) | 0 woke / already not blocked · 1 still blocked · 2 id not found |
| `await <id> [--timeout S --poll S --unblocked]` | block until terminal, or barrier pass with `--unblocked` | no (read-only db) | 0 merged/unblocked · 1 timeout · 2 id not found · 3 cancelled · 4 failed |
| `cancel <id> --reason <text>` | cancel a non-terminal row | yes (state + events) | 0 cancelled · 1 refused (terminal row / missing reason) · 2 id not found |
| `inspect <id> [--lines N]` | resolve claimed_by → live tmux session, capture pane | no | 0 live session captured · 1 no live session · 2 id not found |

**Decision 2: Barrier predicate is shared and mirrors `tick`.**
`wake` and `await --unblocked` use the same two-arm rule as `tick`:
non-sprint rows re-ready when ALL blockers are `merged`; `kind=sprint` rows when ALL
blockers are terminal (`merged|failed|cancelled`). A blocker id that does not resolve to a
row counts as pending (strict — matches `join-status`, unlike tick's vacuous-true JOIN).
Note: the `unblock_dependents` / `unblock_sprint_parents` triggers already perform these
flips on the common path; `wake` is the targeted backstop for rows the trigger missed
(raw-SQL state writes, cross-process races) and a scriptable exit-code surface.

**Decision 3: `wake` is targeted, not a sweep.**
It re-evaluates exactly one row. It emits a `woken` event on the flip and never touches
recovery-sweep markers (`engine-alias-no-work` etc.) — those stay the recovery-sweep's
territory. Idempotent: a row already not blocked exits 0 with `woken:false`.

**Decision 4: `await` is pure read.**
Opens the db read-only (WAL), polls every `--poll` seconds (default 5) up to `--timeout`
seconds (default 3600). Terminal states win immediately (`merged`→0, `cancelled`→3,
`failed`→4); with `--unblocked`, barrier pass also exits 0. Timeout exits 1. Emits one
final JSON line `{id, state, reason}` on exit. No events, no writes of any kind.

**Decision 5: `cancel` refuses terminal rows and never cascades.**
`merged|cancelled|failed` → refuse (exit 1). Children are NOT auto-cancelled (no cascade —
a parent cancel does not imply its children are dead work). Dependents (rows whose
`blocked_by` contains the cancelled id) receive a `blocker-cancelled` event so they can be
triaged, but are NOT unblocked: tick's arm 1 already requires all-merged, so a cancelled
blocker correctly keeps them blocked until a human repoints or cancels them.

**Decision 6: `inspect` resolves row → tmux session via `claimed_by`.**
Worker sessions are named `arc-worker-a-<workerid>` and the claim stores that exact name in
`claimed_by`, so resolution is identity, not lookup. `tmux has-session` gates liveness;
`capture-pane -p -S -N` (default N=200) returns the tail. A row with no claim or a dead
session exits 1 — that is information, not an error.

**Decision 7: Bookie routing unchanged.**
`wake`, `cancel` are writes → agents route them through the bookie subagent. `await`,
`inspect` are reads → unrestricted, same as `list`/`show`. Exit codes make all four
scriptable from bash/pipeliner without parsing JSON.

## Consequences

- Workers can block deterministically on one dependency (`ledger await <child> --timeout 7200`)
  instead of hand-rolled loops; the factory remains the backstop, not the only path.
- A merged blocker's parent wakes immediately via `wake <parent>` — tick stays as the
  global safety net, now with a targeted fast path.
- Cancelled blockers leave an auditable `blocker-cancelled` event on every dependent;
  stuck-blocked rows are diagnosable from the event log alone.
- Four new CLI verbs surface in `--help`; no schema change (states/events already exist).

## Rejected alternatives

- **Extend `tick` with a row id** — tick is a sweep; mixing targeted + global semantics in
  one verb muddies its exit contract and the recovery-sweep's expectations.
- **New `ledger wait <id>` polling via events table** — reading `issues.state` directly is
  cheaper and WAL-safe read-only; no event-tail machinery needed.
- **Cascade cancel to children** — silent mass-cancellation of possibly-live work is
  worse than a triage event; keep the human in that loop.
