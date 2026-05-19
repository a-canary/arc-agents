---
name: improve-architecture
description: "Slice-bounded refactor: clarify boundaries, remove incidental complexity, extract duplication. No behavior change."
---

# improve-architecture — Refactor for Clarity, Not Features

Use when a worker (usually during hygiene phase) notices structural rot — fuzzy module boundaries, duplicated logic, a helper that has outgrown its file — and wants to land a contained refactor without sliding into a feature change.

This skill is *not* for new behavior. If the change alters runtime semantics, file it as a regular `task` row instead.

Wiring this skill into the stop-hook reminder (and any bookie hygiene-emit verb) is Slice D's responsibility — until that lands, workers reach this skill by directory listing or by an explicit pointer from the director.

## When to use

- A function or type is duplicated across ≥2 files with no shared owner.
- A module's public surface no longer matches its name (e.g. `ledger/claim.ts` exporting unrelated helpers).
- A switch / if-chain has grown past ~6 arms and the cases are stable.
- A test file is testing two unrelated concerns and the split is mechanical.

Do **not** use this skill to redesign a subsystem, change a contract, or rename a public CLI verb — those need an ADR or a dedicated task.

## Inputs expected

- The row body names the symptom (e.g. "extract `parseRowId` from ledger.ts + bin/arc-chat.ts into src/ledger/row-id.ts").
- A pre-state diff or grep showing the duplication / smell.
- The CHOICES.md / ADR section the refactor honors (or the constraint it must not violate).

## Deliverable shape

1. A single commit (or short stack) that moves code, with **all call sites updated in the same commit**.
2. `bun test` and `bun run typecheck` green before *and* after the change.
3. PR description spells out:
   - Before: <2-line description of structure>
   - After: <2-line description>
   - Behavior delta: **none** (or list it, in which case re-scope).
4. No `// TODO` left behind. If something is out of scope, file a follow-up ledger row and link it in the PR.

## Slice budget

- Time: ≤60 min of focused work.
- Diff: ≤200 lines net change, ≤6 files touched.

Over budget → stop, decompose into smaller refactors (or file as a real refactor task with an ADR).

## Verification

- `bun test` passes both before the refactor (capture sha) and after.
- `bun run typecheck` clean.
- `git diff --stat` shows the slice respected the budget above.
- Manual: re-grep for the old symbol/duplication — confirm zero hits remain.

## Termination

- **merged** — PR opened, merge-gate green, evidence cites before/after structure + the test-still-green run.
- **failed** — refactor revealed a latent bug or contract ambiguity that needs a real design decision; record the finding in evidence, file a follow-up task, and exit failed (do not paper over).
- **blocked** — refactor depends on an unmerged ADR / sibling slice; decompose into a HITL child that asks the human to sequence the work.
