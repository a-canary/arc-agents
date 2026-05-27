---
name: clarify-docs
description: "Audit and fix documentation that contradicts code. Use when hygiene phase surfaces stale docs, broken cross-references, or ghost task emission from commit-review."
---

# clarify-docs — Repair Documentation Drift

Use when a worker (usually hygiene phase) surfaces stale or broken documentation — docs that contradict code, broken cross-references, or phantom task generation by the commit-review pipeline (cross-repo ghost commits).

This skill handles:
- **Documentation contradictions**: docs that describe behavior that no longer matches the code
- **Broken cross-references**: links to files/paths that no longer exist (ADR references, path anchors)
- **Ghost task emission**: the commit-review pipeline generating tasks for commits/files that don't exist in the target repository (cross-repo phantom commits)

## When to use

The skill is wired into the stop-hook reminder (hygiene phase) and can be triggered by:
- `bin/ledger.ts hygiene-emit --skill clarify-docs --title "..." [--observed-in-task ID]`
- Directory listing of `skills/` in arc-agents

The `hygiene-emit` dedup logic prevents duplicate hygiene rows when the same issue is observed across multiple worker sessions.

## The Phantom Commit Problem

The commit-review pipeline (source_module=commit-review) generates ledger tasks from commit diffs. When it scans a repository and generates a task referencing a file path or commit SHA, the task is tagged `source_module=commit-review` and written to the ledger with `project` field matching the *target* repo.

**Bug**: Tasks are generated against a file/commit that doesn't exist in the target repo. This happens when:
1. The commit-review tool runs against repo A (e.g. Conjecture) and extracts a commit that modifies path `.agent/backlog.md`
2. The resulting task is written with `project=arc-agents` (wrong repo) — the task references commit `b3356f0` and path `.agent/backlog.md` which never existed in arc-agents
3. The task's `source_module=commit-review` field is the only metadata indicating the pipeline that created it

**Root cause**: The commit-review tool uses the *target repo* (the repo it's being run against for review/filing) as the `project` field, but the commit being reviewed is from a *different* repo.

**Evidence**: `archive-or-restore-agent-backlog-md-reso` (Conjecture project) was the source; the hygiene task `clarify-docs-commit-review-automation-ph` (arc-agents project) was filed after the source task failed, identifying that the task was generated from a ghost commit that doesn't exist in arc-agents.

### How to Identify Phantom Tasks

A `source_module=commit-review` task with `project=X` is phantom when:
- The body_md references a commit SHA that doesn't exist in repo X
- The body_md references a file path that never existed at HEAD in repo X
- The source_module doesn't match the project (commit-review tasks for repo A filed against repo B)

Query:
```sql
SELECT id, project, title, body_md
FROM issues
WHERE source_module='commit-review'
  AND (body_md LIKE '%MISSING_AT_HEAD%'
   OR body_md LIKE '%does not exist%'
   OR body_md LIKE '%phantom%')
```

### The Fix: Validate Commit Existence Before Emitting

The commit-review tool should validate that:
1. The referenced commit SHA exists in the target repo
2. All touched files exist at HEAD in the target repo
3. The `project` field matches the repo the commit actually belongs to

If the commit doesn't exist in the target repo:
- **Option A**: Skip task emission entirely (if the commit is irrelevant cross-repo noise)
- **Option B**: Tag the task with the source repo's project and add a `source_repo` field so workers know which repo the commit came from

Implementation: before emitting a task, the commit-review tool should run:
```bash
git -C <target-repo> cat-file -t <commit-sha>
```
If the SHA is unknown, either skip or tag with the correct source repo.

## Inputs expected

- The row body names the symptom (e.g. "commit-review generates phantom tasks for cross-repo commits" or "documentation contradicts current behavior")
- Evidence of the broken state (grep transcript, file status, task ID with source_module=commit-review)

## Deliverable shape

1. **For phantom commit-review tasks**:
   - If the task is genuinely cross-repo noise → cancel the phantom task with evidence
   - If the task references work that needs to happen in a different repo → re-file with the correct `project` field + note the source repo
   - Add validation in the commit-review tool so phantom tasks are never emitted in the first place

2. **For documentation drift**:
   - Update the docs to match current code behavior
   - If the behavior changed without docs update → file a separate task to update the docs

3. **For broken cross-references**:
   - Fix the reference (update path/anchor) OR remove the dead link and add a note

## Verification

- `bun run typecheck` clean
- `bun test` green
- `git diff --stat` shows only the relevant fix (no scope creep)
- For phantom tasks: query ledger confirms no phantom `source_module=commit-review` tasks exist

## Termination

- **merged** — PR opened, merge-gate green, evidence shows:
  - For phantom tasks: the commit-review tool now validates commit existence before emitting
  - For documentation drift: docs match code
  - For broken cross-references: links work or dead links are removed
- **failed** — root cause is outside arc-agents scope (e.g. the commit-review tool lives in a different repo); record finding, file follow-up as needed, exit failed
- **blocked** — fix requires ADR or coordination with a human; decompose into HITL child