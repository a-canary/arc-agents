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

<- **merged** — analysis report committed (or staged in vault), follow-up rows filed manually via `bin/ledger.ts hygiene-emit --skill <s> --title <t> --body <path-to-report> [--observed-in-task <id>]` (one call per row; skills: clarify-docs, improve-architecture, trash-retired-files, analyse-recent-sessions; dedups automatic), evidence rows annotated, PR (if any) merged. This step is a hard gate: if there are no follow-up rows to file, the analysis is complete and the task may merge without any hygiene-emit call.
- **failed** — couldn't find a pattern with N≥3 evidence; record the negative result in evidence (still useful — it rules out a hypothesis) and exit failed.
- **blocked** — pattern points at a decision only the human can make (e.g. "switch model tier for class=hygiene"); decompose into a HITL child carrying the analysis report and the proposed action.

## Pattern shortlist (already documented — point future analyses here)

If a new analysis surfaces a pattern that matches one of these, the analysis should cite the existing ADR and recommend either (a) refining the doc with new evidence, or (b) filing a follow-up row for a layered defense. Do **not** re-litigate the design.

- **30-min watchdog vs compute-heavy ML tasks** → `docs/adr/0008-vast-operator-pattern.md` (operator runs the compute on a vast.ai lease; worker lands the finding). The 11-row evidence base (4 successful + 7 eventually-successful) is in `~/vault/agents/director/journal/analysis-1780697137.md` Pattern 3. A new analysis that sees `exit 124` + `tier=compute`-shaped + a KE note mentioning "operator" or "vast" should reference ADR 0008, not re-propose the design.
