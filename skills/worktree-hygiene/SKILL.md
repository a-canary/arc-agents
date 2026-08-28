# worktree-hygiene

Daily driver that scans estate git worktrees, classifies each into an action
class, and files ONE ledger ticket per finding. **TICKETS ONLY** — it never
executes git mutations (operator brief 2026-07-27). The suggested command is
embedded in the ticket body for the operator/worker who picks it up.

## Run

```bash
bun ~/repos/arc-agents/bin/worktree-hygiene.ts
```

- Config: `$ARC_HYGIENE_CONFIG` or `~/.config/arc/hygiene.yaml` (shared with
  hygiene-tick: `repos`, plus `worktreeHygieneRepos`, `worktreeAbandonDays`,
  `worktreeHygieneMaxPerRun`, `repoBase`).
- Output: JSON `{scanned, findings, filed, skipped}` on stdout + appended to
  `~/.cache/arc-worktree-hygiene.log`.
- Exit 0 ok, 2 config error. One bad worktree/repo logs and continues.

## Action classes (first match wins)

| action   | condition                                        | suggested        |
|----------|--------------------------------------------------|------------------|
| cleanup  | prunable worktree, or abandoned (>= abandonDays old + no live row) | `git worktree prune` / `git worktree remove --force <path>` |
| commit   | uncommitted files + linked row live              | `git commit`     |
| finish   | unpushed commits + linked row live               | `git push`       |
| review   | residue without a live row — human call          | (none)           |
| null     | healthy — no ticket                              | —                |

"Live row" = a ledger row linked by `worktree_path` or `branch` in state
ready/claimed/wip/review.

## Ticket shape

`type=cron, state=ready, kind=task, tier=hygiene, pool=ops`, title
`hygiene: <repo> — worktree:<action>:<branch-or-path-tail>`, id sequence
prefix like hygiene-tick. Skip-not-stack: an open row with the same title
suppresses a duplicate; cap `worktreeHygieneMaxPerRun` (default 10), oldest
last-commit first.

### Unpushed count basis

The ticket body's `unpushed commits: N (basis: ...)` line always states its
count basis — the bare number was the bug (row 000268: stale cached
origin ref reported 76, true post-fetch count was 440). The collector runs
a best-effort `git fetch origin <branch>` before counting; possible bases:

- `@{u}..HEAD post-fetch` — upstream set, fetch succeeded (the number to trust).
- `@{u}..HEAD (fetch failed — count may be stale)` — offline/no-auth; the number reflects the last-cached origin ref, not current remote state.
- `<ref>..HEAD (no upstream — ahead-of-default, not unpushed-to-branch)` — branch has no remote tracking; this is ahead-of-main, NOT commits missing from the branch's remote.
- `(detached — no branch to count)` / `(prunable — worktree dir gone)`.

## Cron

```
0 4 * * * PATH=/home/aaron/.bun/bin:/usr/local/bin:/usr/bin:/bin /home/aaron/.bun/bin/bun /home/aaron/repos/arc-agents/bin/worktree-hygiene.ts >> /home/aaron/.cache/arc-worktree-hygiene.log 2>&1
```

PATH is pinned the way hygiene-tick does it — recovery-sweep's rc=127
incident (bare `bun`/alias commands unresolvable under cron's minimal PATH)
is the lesson.

## Tests

```bash
bun test src/ledger/worktree-hygiene.test.ts bin/worktree-hygiene.test.ts
```

Classifier: table-driven pure rules. Collector: fixture repo with planted
dirty / unpushed+live / abandoned / prunable / clean worktrees; asserts one
ticket per finding, correct action classes, skip-not-stack on second run,
cap ordering, and missing-repo tolerance.
