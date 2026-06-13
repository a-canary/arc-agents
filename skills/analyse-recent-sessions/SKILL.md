---
name: analyse-recent-sessions
description: "Read N recent worker tmux scrollbacks / handoff events, identify recurring friction, write a new skill or update an existing one."
---

# analyse-recent-sessions — Mine Recent Worker Traces for Patterns

Use when a hygiene worker has scrollback and event-log access to a window of recent worker sessions and wants to convert recurring friction into a durable skill update (per the "Pattern Detection & Root-Cause Discipline" rule in `roles/AGENTS.md` / the doctrine loaded by every role).

This skill is the explicit, on-demand counterpart to the stop-hook's `ke-learn`: instead of one session's takeaways, it spans N sessions and looks for shape.

Wiring this skill into the stop-hook reminder (and any bookie hygiene-emit verb) is Slice D's responsibility — until that lands, workers reach this skill by directory listing or by an explicit pointer from the director.

## When to use

- ≥3 recent worker rows showed the same failure mode, the same wasted exploration, or the same hand-holding question.
- A new skill landed recently and you want to check whether workers are actually invoking it correctly.
- The director suspects a class of work is consistently over-budget and wants evidence before re-shaping the workflow.

Do **not** use this skill to debug a single failed row — use `triage-failed` for that. The minimum signal here is N≥3 rows showing the same shape.

## Inputs expected

- A time window or a row-id list (e.g. "last 24h of `class=hygiene` workers" or `["row-a", "row-b", "row-c"]`).
- Access to the ledger event log and (where available) tmux scrollback under `~/vault/agents/<role>/journal/`.
- A hypothesis to test, or "open-ended" if scanning for any pattern.

## Deliverable shape

1. A short markdown report under `~/vault/agents/director/inbox/analysis-<unix-ts>.md` containing:
   - **Window:** time range + row count examined.
   - **Pattern(s) found:** each pattern named, with ≥3 row-ids as evidence.
   - **Root cause hypothesis:** one paragraph per pattern.
   - **Recommended action:** either (a) a new skill (name + one-paragraph charter), (b) an edit to an existing skill (path + one-line diff intent), or (c) a CHOICES / ADR proposal.
2. If recommendation is (a) or (b) **and** the change is slice-bounded (≤30 lines), the slice may include the SKILL.md edit. Otherwise file a follow-up ledger row and link the analysis report from it.
3. A ledger `event` of `kind=note` on each of the N evidence rows pointing to the analysis report path (delegate the write to the bookie subagent — workers do not write to the ledger directly).

## Slice budget

- Time: ≤90 min (reading scrollback is slow).
- Rows examined: ≥3, ≤20 (above 20, the signal is no longer slice-shaped — file an umbrella row).
- Diff: ≤30 lines of code/skill changes within this slice (recommendations beyond that become follow-up rows).

## Verification

- The pattern names ≥3 distinct rows that exhibit it.
- The recommended action is concrete enough that a future worker could execute it without further interpretation.
- If a SKILL.md was edited inline, `bun run typecheck` is still green and the edit is small enough to fit the slice budget.

## Termination

- **merged** — analysis report committed (or staged in vault), follow-up rows auto-filed via `ledger followup-emit --analysis <report-path>` (REQUIRED — the verb parses the "Recommended follow-up rows to file" table and emits one `bookie create` per row, so the next worker sees them on the kanban, not in a journal file), evidence rows annotated, PR (if any) merged. The follow-up-emit step is a hard gate: if the table is missing or empty, exit `failed` (the analysis was incomplete) and re-write the table before re-trying the merge. If the verb is missing, file a hygiene row about the missing verb and proceed with manual follow-up filing.
- **failed** — couldn't find a pattern with N≥3 evidence; record the negative result in evidence (still useful — it rules out a hypothesis) and exit failed.
- **blocked** — pattern points at a decision only the human can make (e.g. "switch model tier for class=hygiene"); decompose into a HITL child carrying the analysis report and the proposed action.
