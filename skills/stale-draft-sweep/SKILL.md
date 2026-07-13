---
name: stale-draft-sweep
description: "Auto-close dead draft PRs older than the staleDraftDays threshold (default 14d): comment with evidence via gh, then close. Never deletes branches."
---

# stale-draft-sweep — Comment-With-Evidence Then Close Dead Drafts

Use when running the hygiene cron's `stale-draft-sweep` skill against a repo. Scope is the close action only — enumerating open draft PRs and classifying which are dead is a separate concern (see `src/ledger/stale-pr-close.ts` for the pure close-action module this skill drives).

## Steps

1. List open draft PRs for the repo: `gh pr list --repo <owner>/<name> --draft --state open --json number,createdAt,headRefName,isDraft,statusCheckRollup`.
2. For each, gather evidence:
   - `ageDays`: days since `createdAt`.
   - `worktreeGone`: true if the head branch's worktree no longer exists locally (or the branch has no recent activity — use judgment; this skill does not own the classifier, only acts on what's already flagged dead).
   - `redGate`: true if `statusCheckRollup` shows a failing/red required check.
3. A PR is dead when `ageDays >= staleDraftDays` (read from `~/.config/arc/hygiene.yaml`'s `staleDraftDays` key via `readStaleDraftDays()` in `src/ledger/stale-pr-close.ts`, default 14) AND (`worktreeGone` OR `redGate`).
4. For each dead PR, call `closeStaleDraft()` from `src/ledger/stale-pr-close.ts` (or replicate its two `gh` calls manually if running outside a TS context): first `gh pr comment` with the evidence, then `gh pr close`. **Never** run `gh pr close --delete-branch` or any branch-deleting command — branches are left intact so a human can resurrect the work.
5. Idempotent: skip PRs that are already closed (the module's `isOpen` check handles this).

## Evidence comment format

See `evidenceComment()` — cites age, worktree-gone, and/or red-gate reasons, and tells the reader the branch is intact and reopenable.
