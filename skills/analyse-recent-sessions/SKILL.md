---
name: analyse-recent-sessions
description: "Read N recent worker tmux scrollbacks / handoff events, identify recurring friction, write a new skill or update an existing one."
---

# analyse-recent-sessions — Mine Recent Worker Traces for Patterns

Use when a hygiene worker has scrollback + event-log access across N recent worker sessions and wants to convert recurring friction into a durable skill update (per "Pattern Detection & Root-Cause Discipline" in `roles/AGENTS.md`). On-demand counterpart to the stop-hook's `ke-learn`: spans N sessions, looks for shape. Slice D wires this into the stop-hook reminder + bookie hygiene-emit; until then workers reach it by directory listing or director pointer.

## When to use

- ≥3 recent worker rows showed the same failure mode, wasted exploration, or hand-holding question.
- A new skill landed recently and you want to verify workers invoke it correctly.
- Director suspects a class of work is consistently over-budget and wants evidence before re-shaping.

Do **not** use this to debug a single failed row — that's `triage-failed`. Minimum signal here is N≥3 rows showing the same shape.

## Inputs expected

A time window or row-id list (e.g. "last 24h of `class=hygiene` workers" or `["row-a","row-b","row-c"]`); access to the ledger event log and tmux scrollback under `~/vault/agents/<role>/journal/`; a hypothesis to test, or "open-ended".

## Deliverable shape

1. Markdown report at `~/vault/agents/director/inbox/analysis-<unix-ts>.md` with **Window** (time range + row count), **Pattern(s) found** (each named, with ≥3 row-ids as evidence), **Root cause hypothesis** (one paragraph per pattern), **Recommended action** — (a) a new skill (name + one-paragraph charter), (b) edit to existing skill (path + one-line diff intent), or (c) CHOICES/ADR proposal.
2. If (a)/(b) is slice-bounded (≤30 lines), the slice may include the SKILL.md edit; otherwise file a follow-up ledger row and link the analysis report from it.
3. A ledger `event` of `kind=note` on each evidence row pointing to the analysis report path (delegate the write to bookie — workers do not write the ledger directly).

## Slice budget

- Time: ≤90 min (reading scrollback is slow).
- Rows examined: ≥3, ≤20 (above 20 signal is no longer slice-shaped — file an umbrella row).
- Diff: ≤30 lines of code/skill changes (recommendations beyond that become follow-up rows).

## Verification

Pattern names ≥3 distinct rows; recommended action is concrete enough that a future worker could execute it without further interpretation; if a SKILL.md was edited inline, `bun run typecheck` is green and the edit fits the slice budget.

## Termination

- **merged** — analysis report committed (or staged in vault), evidence rows annotated, PR (if any) merged.
- **failed** — couldn't find a pattern with N≥3 evidence; record the negative result (still useful — rules out a hypothesis) and exit failed.
- **blocked** — pattern points at a decision only the human can make (e.g. "switch model tier for class=hygiene"); decompose into a HITL child carrying the analysis report + proposed action.
