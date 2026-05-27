# Verification Evidence: scoreResult() fix and fresh-install logic

**Task:** verify-scoreresult-fix-and-fresh-install
**Verdict: FAILED**

---

## Finding 1: `scoreResult()` function does NOT exist

### Evidence

- Searched entire `arc-agents` repo (all branches, all commits) for `scoreResult`:
  ```
  $ grep -r "scoreResult" --include="*.ts" /home/aaron/repos/arc-agents
  # no output — function not found
  ```

- The closest match is `scoreStructuralFromText()` from commit `1fed44ed`:
  - Located at: `src/scorer/scorer.ts` (only on branch `origin/worker/replace-size-ratio-scoring-with-llm-judg`)
  - Not merged to `main` or `HEAD`
  - Returns `ScoreResult` (a **type**), not a function called `scoreResult()`
  - Function name mismatch: commit message claims `scoreResult()` but actual function is `scoreStructuralFromText()`

- `src/scorer/` directory does not exist at HEAD:
  ```
  $ ls /home/aaron/repos/arc-agents/src/scorer/
  # no scorer dir
  ```

### Conclusion

The `scoreResult()` function described in the commit message does not exist in the codebase. The scorer module (with a different function name) exists only on an unmerged branch.

---

## Finding 2: Fresh-install wipes learned state does NOT exist

### Evidence

- Searched all branches and commits:
  ```
  $ git log --all --format="%H %s" | grep -i "fresh.*install\|fresh.*wipe\|wipe.*learn\|ke.*clear\|knowledge.*clear"
  # no output
  ```

- `bin/merge-gate.sh` mentions "fresh worktree" only in context of `bun install` before typecheck/test — no learned-state wiping logic.

- No code anywhere in `arc-agents` handles wiping `~/vault/ke/` or any learned state on fresh install.

### Conclusion

No fresh-install logic for wiping learned state exists in the codebase.

---

## Finding 3: Source commit does not exist

- The task references commit from 2026-03-29T13:22:12Z titled "feat: fig4 architecture diagram + flywheel benchmark with QA scores"
- No such commit exists in git history (no March 2026 commits found)
- Commit `1fed44ed` (scorer module) is dated 2026-05-27 — different date and different content

---

## Summary

The rubric was correct: the commit message describes code fixes that are NOT present in the diff or codebase.

| Claim | Status |
|---|---|
| `scoreResult()` function implemented | ❌ NOT FOUND |
| Fresh-install wipes learned state | ❌ NOT FOUND |
| Source commit exists | ❌ NOT FOUND |

Recommended action: The source branch `worker/replace-size-ratio-scoring-with-llm-judg` needs to be merged (after fixing function name), and fresh-install logic needs to be implemented separately.
