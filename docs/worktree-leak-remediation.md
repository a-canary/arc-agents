# Worktree leak remediation

Status: GC executed 2026-09-12 (scope item 2 done); fast-forward of `main` (scope item 1) still open.
Measured 2026-09-12 against `origin/main`.

## Generator

`bin/factory.test.ts` pointed `ARC_PROJECT_REPO_ARC_AGENTS` at the live repo (`REPO`) at three
sites, so `git worktree add` registered gitdirs under `/home/aaron/repos/arc-agents/.git/worktrees/`
that the tests never deregistered. Git's collision dedup appended `-path-strip` / `-solo` suffixes,
producing a series of near-duplicate directories.

Fixed upstream by `913ab76` (PR #505): the tests now `git init` a throwaway `scratch-repo` under
`workDir`, so `afterEach`'s `rmSync` takes the registry with it.

## Measured state

| Metric | Count |
|---|---|
| `main` behind `origin/main` | 56 |
| `main` ahead of `origin/main` | 1 (`4693b59`, content-redundant — see below) |
| Worktrees registered | 130 |
| Suffixed dirs on disk | 75 (71 registered, 5 unregistered, 3 orphaned gitdir in `/tmp`) |
| Suffixed dirs holding nothing absent from `origin/main` | 67 |
| Suffixed dirs needing individual sign-off | 5 |

The remaining 3 of 75 have their gitdir in `/tmp` with the parent repo gone, so they carry no
recoverable git state at all.

## Why `4693b59` is not work at risk

`main`'s local-only tip touches `config.json` only, and
`git diff 4693b59:config.json origin/main:config.json` is empty — the change was absorbed upstream
by a different commit rather than cherry-picked, so ancestry tests call it "unmerged" while its
content is fully present. The fast-forward therefore loses nothing.

This is why a naive `merge-base --is-ancestor` audit reports only 2 safe artifacts: 67 of them are
based on `4693b59` and read as divergent on reachability while being content-redundant.

## Decision (scope item 3): reap, do not rebase

Rebasing is O(n) conflict resolutions across 119 worktrees that still carry the pre-fix base, against
branches that are ephemeral by design. A pre-fix base is dormant, not active — it only leaks when the
factory suite is actually run, and a worker executes its own slice, not the full suite.

1. Leak artifacts holding nothing absent from `origin/main` → reap unconditionally.
2. The 26 worktrees with genuinely distinct unmerged HEADs → never blanket-reap; each reaches its own
   terminal state through the ledger.
3. Retaining a pre-fix base is acceptable without a rebase, because the fix is in the test file the
   worktree will pick up on its next branch-off from `origin/main`.

## Re-audit

A suffixed directory is reap-safe when it introduces no commit beyond the content-redundant
`4693b59` and has no working-tree content of its own:

```sh
cd ~/repos/arc-agents
for d in ~/worktrees/*-path-strip ~/worktrees/*-solo; do
  [ -d "$d" ] || continue
  h=$(git -C "$d" rev-parse HEAD 2>/dev/null) || continue
  mb=$(git merge-base "$h" origin/main 2>/dev/null) || continue  # skip orphaned gitdirs
  uniq=$(git rev-list "$mb".."$h" 2>/dev/null | grep -vc "^4693b59")
  dirty=$(git -C "$d" status --porcelain | wc -l)
  [ "$uniq" -eq 0 ] && [ "$dirty" -eq 0 ] && echo "REAP $d"
done
```

Reproduces 67 REAP / 5 KEEP as of 2026-09-12. Do not substitute a bare
`merge-base --is-ancestor` or a `git diff origin/main <head>` tree comparison: the first misreads
`4693b59` as unique work, and the second flags ~65 files on worktrees that merely sit 56 commits
*behind* `origin/main`.

## The 5 that need sign-off (all cleared)

| Worktree | Finding |
|---|---|
| `…factory-kind-job-shell-task-rows-path-strip-path-strip-path-strip` | Unique commit `a229989` "test(ledger): add regression test for path-strip whitespace handling" — its test body is already on `origin/main` at `bin/ledger.test.ts:2463`. Untracked file is a `package-lock.json`. |
| `…daily-driver-collector--path-strip` | 41 staged changes, but `git write-tree` = `5064d88`, byte-identical to `6c1a4c0` on `origin/main`. Stale-base delta, zero original work. |
| `…daily-driver-collector--solo` | Same as above. |
| `fake-path-strip` | Empty directory; "dirty" status leaks from `$HOME`. |
| `fake-solo` | Same as above. |

No unique work exists in any of the 75.

## GC executed (scope item 2, 2026-09-12)

Ledger task `gc-the-67-reap-safe-leaked-worktree-dire`.
The re-audit snippet printed **63 REAP / 3 KEEP / 5 ORPHAN** at execution time — down from the
67 REAP measured during analysis, because four had already been reaped in the interim.

Pre-flight checks, all clean:

| Check | Result |
|---|---|
| Live process cwd inside any REAP dir | 0 (only this task's own worktree, not in the list) |
| Non-terminal ledger rows referencing a REAP dir | 0 of 83 rows carrying a `worktree_path` |

The process check is not optional: KE `infrastructure/worktree-reaper-race.md` records a reaper
removing a worktree out from under a still-live worker, which invalidated its bash cwd.

Reaped by **trash-move, not `rm`** — `~/trash/1789194822_worktree-leak-gc/` (651M), carrying a
`REASON.md` and a `MOVED.txt` manifest of all 63 paths. Then `git worktree prune -v` cleared the
63 now-dangling registry entries.

Acceptance, both met:

| Criterion | Result |
|---|---|
| No reap-safe suffixed dirs remain under `~/worktrees` | 0 REAP on re-audit |
| `git worktree prune --dry-run -v` stays at 0 | 0 |

Registered worktrees fell 127 → 64. The 8 sign-off entries (3 KEEP + 5 ORPHAN) were left in place.

Reverse an individual entry with:

```sh
git -C ~/repos/arc-agents worktree add <path> <branch>
```

## Still open: scope item 1 (fast-forward `main`)

Local `main` is still `4693b59` — 57 behind, 1 ahead of `origin/main`. Out of scope for the GC
task; needs its own ledger row. The recovery tag `pre-ff-main-backup-20260912` is in place at
`4693b59`, so the fast-forward stays reversible:

```sh
git -C ~/repos/arc-agents branch -f main pre-ff-main-backup-20260912
```

The route previously refused by the auto-mode classifier was `git branch -f main origin/main`
(Irreversible Local Destruction); the trash-move route used for the GC above suggests a
scratch-worktree `merge --ff-only` is worth retrying.
