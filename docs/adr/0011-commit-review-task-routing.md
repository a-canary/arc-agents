# ADR 0011 — commit-review Pipeline Module

**Date:** 2026-05-27
**Status:** proposed
**Decides:** `source_module=commit-review` row emission, portfolio-wide task routing, and worktree isolation gap

---

## Context

The `commit-review` module (referenced as "Build commit-review pipeline module" in `~/.claude/tasks/91d2158c-9b7d-4815-ab68-ea9db28a7efe`) enumerates commits across portfolio repos, fetches diffs, and uses `minimax-2.7` to review against a rubric. It emits ledger rows (`source_module=commit-review`) containing:

- Target repo (in `project` column)
- Commit SHA, author, message
- Reviewer rationale + recommended action
- The originating commit date

These rows can target any repo in the portfolio (`arc-agents`, `Conjecture`, etc.).

## Problem

`worker-shell.sh` uses `ARC_WORKER_SHELL_SOURCE_ONLY=1` to isolate every worker into the **arc-agents** worktree, regardless of the row's `project` field. The isolation is hardcoded to the parent repo path (`$REPO`), which is always `~/repos/arc-agents`.

When `commit-review` emits a row targeting `project=Conjecture`:

1. A worker claims the row → `state=claimed` → `worktree_path` set to `~/worktrees/arc-agents-<claim-id>/`
2. Worker boots inside `arc-agents` worktree
3. Worker finds no relevant code → must decompose into a HITL child for director review
4. The task eventually gets re-assigned and executed **outside** the arc-agents framework (manually, in `conjecture`'s own environment)

The `evidence` for `add-test-coverage-for-processcontextbuil` confirms this: *"No arc-agents code relevant to task brief. Work done in /home/aaron/repos/conjecture."*

This wastes a worker slot and adds latency. More critically, the task's `worktree_path` and `branch` columns are **wrong** — they point into `arc-agents` worktrees even though the work happened in `conjecture`.

## Alternatives Considered

### A — No routing rules (current state, confirmed broken)

The gap was not a bug — it was a decision that had not been made. The system has no guidance for cross-repo task routing. This is the observed outcome.

### B — Self-validating emit (preferred)

`commit-review` module is **responsible** for its own rows. Before emitting a task row, it:

1. Checks whether the target repo's worktree exists or can be provisioned
2. If not, either defers (waits for the worktree to be ready) or sets the correct `worktree_path` on the row at create time

**Advantage:** The source module has the most context — it knows the target repo, can resolve `~/worktrees/<repo>-*/`, and can pre-create the worktree.
**Disadvantage:** `commit-review` must gain knowledge of the worktree management protocol (worktree naming, branch convention, provisioning).

### C — Hygiene pre-flight in `hygiene-emit` / `bookie`

When a `source_module=commit-review` row is emitted, the `hygiene-emit` handler or `bookie-validator.ts` intercepts it, checks `project ≠ arc-agents`, and:

1. Blocks with a HITL prompt to the user asking for confirmation, OR
2. Sets `hitl=1` on the row, requiring director review before the task is dispatched

**Advantage:** No changes to `commit-review` module.
**Disadvantage:** Adds a mandatory pre-flight check to the hygiene pipeline. `hygiene-emit` currently has no awareness of `project` or `source_module`. This is a non-trivial coupling.

## Decision

**Pattern B is preferred.** The `commit-review` module owns its rows and is responsible for correct worktree provisioning before emitting `source_module=commit-review` task rows.

**Pattern C is the fallback** for any module that cannot self-validate (e.g. a third-party UX module that emits via the UX Module Contract, or an ad-hoc `hygiene-emit` call from a worker that observed an issue in a non-arc-agents repo).

**Decision recorded in CHOICES.md §S-0006.**

## Consequences

### Positive
- `commit-review`-sourced tasks land in the correct worktree on first claim.
- `worktree_path` and `branch` columns are accurate for portfolio-wide audit.
- Workers never waste a slot on a task they cannot execute.

### Negative
- `commit-review` module must implement worktree provisioning logic.
- A new `commit-review` task targeting a non-arc-agents repo may block if the target repo's worktree cannot be created (e.g. repo not cloned locally). The module needs a fallback strategy.
- Pattern C's `hygiene-emit` fallback is not yet implemented — a separate implementation task is required.

### Open
- Does `commit-review` own the worktree provisioning, or does it delegate to a shared `provision-worktree` utility?
- What happens when a `commit-review` task targets a repo that has no local clone at `~/repos/<name>/`?
- The `evidence` from `add-test-coverage-for-processcontextbuil` flagged an **ADR conflict** between the task's branch (`worker-shell.sh` revert of reconcile_decision) and main HEAD (`a67039e` implements exit-code-independence). This is a separate concern (I-0008 diff-review gate surfacing non-brief content) and is tracked as a follow-up.