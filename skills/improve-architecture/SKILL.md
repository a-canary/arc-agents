---
name: improve-architecture
description: "Slice-bounded refactor: clarify boundaries, remove incidental complexity, extract duplication. No behavior change."
---

# improve-architecture — Refactor for Clarity, Not Features

Workers (usually during hygiene phase) reach this skill when they notice structural rot — fuzzy module boundaries, duplicated logic, a helper that has outgrown its file — and want to land a contained refactor without sliding into a feature change. If the change alters runtime semantics, file it as a regular `task` row instead. Slice D wires this into the stop-hook reminder + bookie hygiene-emit; until then workers find it by directory listing or director pointer.

## When to use

- A function or type is duplicated across ≥2 files with no shared owner.
- A module's public surface no longer matches its name (e.g. `ledger/claim.ts` exporting unrelated helpers).
- A switch / if-chain has grown past ~6 arms and the cases are stable.
- A test file is testing two unrelated concerns and the split is mechanical.

Do **not** redesign a subsystem, change a contract, or rename a public CLI verb — those need an ADR or a dedicated task.

## Inputs expected

Row body names the symptom (e.g. "extract `parseRowId` from ledger.ts + bin/arc-chat.ts into src/ledger/row-id.ts"); a pre-state diff or grep showing the duplication / smell; the CHOICES.md / ADR section the refactor honors (or the constraint it must not violate).

## Deliverable shape

1. A single commit (or short stack) that moves code, with **all call sites updated in the same commit**.
2. `bun test` and `bun run typecheck` green before *and* after.
3. PR description: Before / After (2-line each) + Behavior delta: **none** (or list it, in which case re-scope).
4. No floating reminders. Out-of-scope work → follow-up ledger row, linked in the PR.

## Slice budget

- Time: ≤60 min of focused work.
- Diff: ≤200 lines net change, ≤6 files touched.

Over budget → stop, decompose into smaller refactors (or file as a real refactor task with an ADR).

## Verification

`bun test` passes before (capture sha) and after; `bun run typecheck` clean; `git diff --stat` respects the budget; re-grep for the old symbol/duplication → zero hits.

## Termination

- **merged** — PR opened, merge-gate green, evidence cites before/after structure + the test-still-green run.
- **failed** — refactor revealed a latent bug or contract ambiguity needing a real design decision; record the finding, file a follow-up task, exit failed (do not paper over).
- **blocked** — refactor depends on an unmerged ADR / sibling slice; decompose into a HITL child that asks the human to sequence the work.
