# Evidence: remove-stale-benchmark-references-from-s — Null-Op

## Task
Remove stale benchmark references from `STANDARD_BENCHMARK_REPORT.md` and `PLAN.md`.

## Findings

### These files have NEVER existed in arc-agents

Searched exhaustively across all reachable + unreachable commits:
- `git log --all -S "STANDARD_BENCHMARK_REPORT"`: 0 hits
- `git log --all -S "gsm8k_standard_benchmark"`: 0 hits  
- `git log --all -S "mmlu_standard_benchmark"`: 0 hits
- `git ls-tree -r <HEAD>` across all reachable commits: never tracked
- Unreachable commit traversal: not present
- Parent repo `/home/aaron/repos/arc-agents`: not present

### What benchmark content exists in arc-agents

Benchmark-related content in arc-agents lives in two files sourced from `/home/aaron/repos/conjecture/`:
- `docs/adr/0007-three-prompt-architecture-findings.md` (97c2208): GSM8K regression (−2pp), sourced from `.director/state.json` (conjecture bdc66c2, 2026-03-06). References `/home/aaron/repos/conjecture/experiments/results/`.
- `docs/evidence_bbh_validation_complete.md` (c2dbd39): BBH validation (+9pp). References `experiments/results/benchmark_results.csv`.

Neither references `STANDARD_BENCHMARK_REPORT.md`, `gsm8k_standard_benchmark.py`, or `mmlu_standard_benchmark.py`.

### Task source was a false positive

The rubric-generated task incorrectly assumed these files existed and cross-referenced each other. The source commit (2026-03-06) only contained metadata files — benchmark scripts were in the conjecture repo, not arc-agents. The commit-review agent made an incorrect "MISSING_AT_HEAD" claim.

### Worktree state
```
On branch worker/remove-stale-benchmark-references-from-s
nothing to commit, working tree clean
git diff main: 0 .md changes (backstop removal only)
```

## Conclusion

No stale benchmark references exist in arc-agents. Nothing to remove. Task is a null-op.
