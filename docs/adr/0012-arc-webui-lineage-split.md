# ADR 0012 — arc-webui Lineage Split (origin/master vs _primary/main)

**Status:** Accepted — 2026-06-22
**Related:** task `clarify-docs-webui-a-canary-webui-master` (observed during task `000101-hygiene-arc-webui-improve-architecture`).

## Context

`github.com/a-canary/webui` and the factory's working clone (`~/repos/arc-webui`) carry **two unrelated default-branch lineages**:

| Ref | SHA | Source |
|---|---|---|
| `origin/master` | `1b60e9b` "kanban: make read-only reflection of issues.db" | a-canary/webui on GitHub |
| `_primary/main`  | `2688c14` | factory local ref (no upstream) |

`git merge-base origin/master _primary/main` exits 1 (empty). They share **zero commits**.

Consequence: any hygiene/feature branch off `_primary/main` cannot be PR'd against `origin/master` — `gh pr create --base master` rejects with "no history in common". The hygiene refactor committed on `hygiene/arc-webui-filters-url-dedup` is one such branch; it sits un-mergeable until the lineage split is resolved.

The split appears to be an organic fork: origin/master is the public mirror of a-canary/webui at one snapshot; _primary/main is the factory's independent workstream (≈160+ commits ahead) maintained via direct commits, never rebased or pushed.

## Decision

**The four remediations are operator-owned. Until the operator picks one, hygiene/feature branches off _primary/main land locally only and do not file PRs.**

The operator's menu (verbatim from the originating row body), unchanged:

1. Force-push `_primary/main` onto `origin/master` (rewrites public history — destructive).
2. Rename `_primary/main` → `origin/webui-main` and PR against it.
3. Rebase `_primary/main` onto `origin/master` (loses the ≈160 factory commits unless they're already in master — verify first).
4. Confirm with operator which lineage is canonical before doing anything.

**Worker posture (documented for future tasks):**
- Hygiene/feature work touching arc-webui continues in `_primary/main` (the factory's active line).
- Branch is pushed to `origin` under a worker-prefixed name and an open PR is filed **only after** the operator has resolved the lineage split.
- Until then, `pr_url` stays `null` on the row; `evidence_md` records the lineage state and the local-only merge (`git log` excerpt + merge-base-empty output).
- A `git fetch origin` + `git merge-base origin/master _primary/main` check is the canonical verification at merge time.

**Docs-only PRs in arc-webui itself are fine** (no merge-base concern: pure documentation edits rebase cleanly). The constraint applies to commits that diverge the factory's working line.

## Why not alternatives

**Path (a) — Auto-resolve the lineage split in worker (rebase / rename / force-push).** Rejected: every option is destructive on a public repo (force-push) or loses work (rebase without verification). Worker is not authorized to touch `origin/master`. Per CLAUDE.md, public-facing operations need operator approval.

**Path (b) — File the PR against `origin/master` and let GitHub auto-detect.** Rejected: GitHub rejects with "no history in common"; not a workaround path.

**Path (c) — Document the split + defer the decision.** Accepted. This slice is ≤3 files (the ADR + an optional CHOICES cross-link), no code change, no destructive operation, reversible by operator choice later. Slice budget: ≤30 min.

## Consequences

**Positive:**
- Future workers touching arc-webui see the split in their context (ADR + row body) instead of rediscovering it via a `gh pr create` rejection.
- Local-only merges remain a valid terminal state on hygiene/feature rows until the operator acts.
- Operator is named as the decision owner; no autonomous force-push.

**Negative / accepted costs:**
- Hygiene work on arc-webui accumulates locally without upstreaming. The longer the split persists, the larger the eventual rebase cost.
- The local hygiene branch (`hygiene/arc-webui-filters-url-dedup`) and any new ones sit un-PR'd. They are not lost (git is durable) but they are not visible on `github.com/a-canary/webui`.

**Out of scope (filed as follow-up, not this ADR):**
- An `arc-webui lineage-sync` slice that audits the ≈160 commits in `_primary/main` against `origin/master` and reports which are already-public vs factory-only. Required before any rebase attempt (remediation #3). Belongs in a `class=quality` row once the operator signals the chosen remediation.
- A factory-side policy that blocks `gh pr create --base master` for any arc-webui row, with a clearer "lineage split unresolved" error message. Belongs in `bin/worker-shell.sh` or a hook, not in docs.

## How we verify

- **The canonical merge-base check exits 1** until the operator resolves the split. `git -C ~/repos/arc-webui merge-base origin/master _primary/main; echo "exit=$?"` returns `exit=1`.
- **No PR is filed against `origin/master`** for any arc-webui row until that exit code flips to 0.
- **A `ke` note is filed when the operator picks a remediation** (force-push / rename / rebase) and the next worker after that point should update this ADR's Status line to "Resolved — <date> — <remediation>".

## Cross-references

- ADR 0001 — Ephemeral Workers via Factory. Worker hands off the lineage decision to operator; factory stays repo-agnostic.
- Task `000101-hygiene-arc-webui-improve-architecture` — the slice that triggered this observation; its branch `hygiene/arc-webui-filters-url-dedup` is the canary stuck on `_primary/main`.
- Task `clarify-docs-webui-a-canary-webui-master` — this ADR's originating hygiene row.
