# Decision: `ledger status` — Linear Probe Over Worktree Dirs (Orphan-First Safety)

**Date:** 2026-07-13
**Status:** accepted
**Row:** `clarify-docs-ledger-linear-probe-over-a-`
**Source:** `bin/ledger.ts:1623` ponytail annotation
**Observed in:** `000242-hygiene-arc-agents-ponytail-audit`

---

## TL;DR

`ledger status --worktree-root ~/worktrees` needs to run `git worktree list
--porcelain` on a real git worktree to discover all registered worktrees for
the repo. It cannot assume the first directory returned by `readdirSync` is a
valid worktree — an orphan (non-git) dir may appear first, and `readdir` order
varies across filesystems. The fix: probe candidate dirs in a loop until one
succeeds, report scan failure only if none do.

## Design

```
candidates = dirs matching repoPrefix under worktreeRoot, filtered to directories
for each candidate:
    probe = spawnSync("git", ["-C", candidate, "worktree", "list", "--porcelain"])
    if probe.status == 0:
        sample = candidate; break
if sample found:
    parse porcelain output → registered worktree map
    untracked = fullDirs not in registered map
    mergeable = registered worktrees whose HEAD is strict ancestor of main
else:
    worktreeScanError = "no valid worktree dir found under ..."
```

Key properties:

1. **Probe all, fail gracefully.** Each candidate gets one `git worktree list`
   call. If none succeeds, `worktreeScanError` is set (reported by `--strict`
   mode) instead of silently treating all dirs as untracked.

2. **No sorting or ordering dependency.** `readdirSync` returns dirs in
   filesystem-inode order (ext4, btrfs, tmpfs all differ). CI surfaced the
   orphan-first case on a fresh checkout where leftover non-git dirs sorted
   before real worktrees. The inner loop is order-agnostic.

3. **Single anchor sample.** Once a valid worktree is found, `git -C <sample>
   worktree list --porcelain` reports *all* registered worktrees for that
   repo's `.git` — not just the anchor. The parsed map covers every worktree,
   so the untracked-vs-registered comparison is complete.

## Why not alternatives

- **`readdirSync(...).sort()`** would mask the issue but not fix it — orphan
  dirs would still fail `git worktree list` and produce the same silent empty
  scan. Sorting only changes *which* bad dir gets probed first.

- **`fs.stat` + check for `.git` or `HEAD`** before the git call was considered
  but duplicates work: `git -C cand worktree list` already fails fast on
  non-git dirs. A stat-based pre-check would add a filesystem call per
  candidate with no correctness benefit.

- **Default to `~/repos/<repo>/`** was rejected because the goal is to scan
  *created worktrees*, not the canonical clone. `worktree list` from the main
  repo clone would also work, but it would miss dirs that aren't registered
  yet (orphans) — and we want to report those as untracked.

- **Skip `git worktree list` entirely, use directory listing only** was
  rejected because untracked detection requires the registered set. Without
  `git worktree list`, every dir under `worktreeRoot` looks untracked.

## Cross-references

- `bin/ledger.ts` — `status` command, worktree scan block starting at line ~1600
- `docs/adr/0005-ledger-schema-prd-v1.md` — ledger schema that this status
  command reports on
- `bin/worktree-reaper.ts` — consumer of `mergeable_worktrees` and
  `untracked_worktree_dirs` from this scan
- `000242-hygiene-arc-agents-ponytail-audit` — the hygiene run that surfaced
  this as undocumented
