# memory-bench — CONFIG & TASK SET (slice #3 decision)

This file records the canonical CONFIGS and TASKS registries wired into
`harness.py` and used by `harness_multi.py`, `audit_coverage.py`, and the
slice #4 orchestrator. Any change here is slice-boundary work: update the
list in `harness.py`, this file, and the slice's PR description together.

## Source-of-truth lineage

| Source | Status | What it contributes |
|---|---|---|
| `hermes-memory-bench/scripts/run_benchmark.py:TASK_IDS` | **canonical** | the 6 task ids `t01`…`t06` |
| `~/.hermes/profiles/memory-bench-*` (10 dirs) | **read-only** | the live Hermes profile surface |
| Parent PRD `i-benchmark-config-coverage-audit-wpki` | **scope-defining** | "8 configs, 5/6/7/9/13 tasks" with Phase 1 + 2 + X1 task-set options |
| HITL child `hitl-benchmark-spec-task-set-and-configs` | **recommendation only** | recommended A (cancel + GC); user has not answered |
| Slice #3 brief `i-benchmark-wire-configs-into-harness` | **operative** | the 8-config example and the 7/9/13 task-set options |

## Decision (slice #3)

### CONFIGS — 8 profiles

```
memory-bench-builtin
memory-bench-flowstate
memory-bench-ke
memory-bench-mem0
memory-bench-noledge
memory-bench-obsidian
memory-bench-plur
memory-bench-wiki
```

**Excluded by default:** `memory-bench-hermes` and `memory-bench-holographic`.
These are the two `Hermes-Memory` profile variants in
`~/.hermes/profiles/`; they exist as baselines / control surfaces
(`hermes-baseline` is the no-memory echo control, `holographic-baseline`
is a context-only control). The slice #3 brief example also excludes
them and notes "ONLY if HITL picked option B/X1" — which the HITL child
has not endorsed. They can be added in a future slice by importing
`harness.CONFIGS` and `.append("memory-bench-hermes")` etc.

**Why 8 and not 10:** the 8 profiles are the distinct *memory backends*
(`builtin` / `flowstate` / `ke` / `mem0` / `noledge` / `obsidian` /
`plur` / `wiki`); the 2 excluded profiles are *control surfaces* whose
purpose is to be a baseline, not a peer in the memory-sweep Elo.

### TASKS — 6 tasks

```
t01  Multi-Hop Reasoning Chain
t02  Research Gap Analysis & Literature Synthesis
t03  Counterfactual Design Critique
t04  Archival Knowledge Retrieval Under Degradation
t05  Cross-Temporal Analogical Reasoning
t06  Error Propagation Analysis in Multi-Agent Pipelines
```

**Why 6 and not 7/9/13:** the parent PRD and the slice #3 brief offer a
menu (5/6/7/9/13 tasks) tied to phased scope expansion. The 6-task set
matches the canonical `TASK_IDS` in `hermes-memory-bench/scripts/run_benchmark.py`
and is the only set with Markdown files on disk (in
`/home/aaron/benchmark/hermes-memory-bench/tasks/t*.md`, copied verbatim
into `memory-bench/tasks/`). The slice brief's "Do NOT add new tasks"
constraint forbids inventing t07+; the 7/9/13 options are downstream
slices that bring their own task files (Phase 2 `architecture_review` is
explicitly out of scope per the brief).

The 5-task floor in the parent PRD predates `t06_error_propagation_rag.md`
and is stale; the 6-task set supersedes it.

## Verification commands (slice #3 acceptance)

```bash
# 1. Registries are populated, names canonical, hermes/holographic excluded
python3 -m pytest memory-bench/tests/test_audit_coverage.py -v -k "registries or hermes or task_files"

# 2. CLI surface — --list-configs, --list-tasks return the full sets
python memory-bench/harness.py --list-configs    # → 8 lines
python memory-bench/harness.py --list-tasks      # → 6 lines
python memory-bench/harness_multi.py --list-configs   # → 8 lines
python memory-bench/harness_multi.py --list-tasks     # → 6 lines

# 3. --dry-run prints the matrix without API calls
python memory-bench/harness_multi.py \
    --configs memory-bench-builtin,memory-bench-ke \
    --tasks t01,t02 \
    --reps 3 \
    --dry-run
# → 12 lines: <config>\t<task>\trep-NN

# 4. Live 1×1 backfill wipes runs/<config>/<task>/rep_1/ and writes a
#    result record (slice #3 stub returns an error sentinel — that's
#    expected; slice #4 wires the real LLM call).
python memory-bench/harness_multi.py \
    --configs memory-bench-builtin \
    --tasks t01 \
    --reps 1
# → memory-bench/runs/memory-bench-builtin/t01/rep-01/result.json

# 5. Config isolation: a run for memory-bench-builtin must not touch
#    another config's runs/ tree. The cross-config test in
#    tests/test_harness_multi.py exercises this.
```

## Downstream impact

- `audit_coverage.py` will now size the matrix at 8 × 6 = 48 cells.
  With no runs, the gate exits non-zero (48 cells below threshold).
  After the slice #4 backfill completes, every cell needs ≥ 3 reps
  to pass the default threshold.
- The slice #3 stub `harness.run_one()` returns a `result.json` whose
  `error` field carries the sentinel `slice-#3: orchestrator stub
  (slice #4 wires the LLM call)`. Slice #4 replaces this with the
  real `hermes chat` invocation in a tmux session (mirroring
  `hermes-memory-bench/scripts/run_benchmark.py:run_hermes_task`).
- The 10-profile surface on disk is **unchanged** — slice #3 only
  reads it. Slice #4 will use `HERMES_HOME / profiles / <config>` as
  the per-config workspace.
