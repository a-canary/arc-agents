# memory-bench

Hermes memory backend benchmark harness. Orchestrates runs of the
memory-enabled `memory-bench-*` Hermes profiles against a fixed set of
complex-reasoning tasks and aggregates quality / cost / Elo metrics.

## Layout

```
memory-bench/
├── README.md                # this file
├── harness.py               # single-config single-task orchestrator
├── harness_multi.py         # multi-config runner with --configs / --tasks filters
├── audit_coverage.py        # config × task matrix printer + threshold gate
├── tasks/                   # task YAML / Markdown definitions (slice #1 / #3)
├── statistics/              # statistics writer outputs (slice #4)
├── elo/                     # Elo writer outputs (slice #4)
├── runs/                    # per-config per-task per-rep run directories
└── tests/                   # pytest smoke + unit tests
```

## Source of truth

The 2-config `hermes-memory-bench/` is the structural model for
`harness.py` and `harness_multi.py` (tmux + Hermes chat pattern,
JSONL result stream, `summary.json` writer). The new harness
generalises that to 8–10 configs and 5/6/7/9/13 tasks.

## Slices

| # | Slice | Status |
|---|-------|--------|
| 1 | task YAML selection (5/6/7/9/13 tasks) | HITL |
| 2 | scaffold the tree | done |
| 3 | **wire the 8 configs + 6 tasks into `harness.py`** | **done** |
| 4 | statistics + Elo writers + backfill runner | not started |

## Quick start

```bash
# run all tests
python -m pytest memory-bench/tests/ -v

# show the registered sets
python memory-bench/harness.py --list-configs       # → 8 lines
python memory-bench/harness.py --list-tasks         # → 6 lines

# preview the full matrix without burning API budget
python memory-bench/harness_multi.py --dry-run

# run a 1×1 backfill (slice #3 stub; slice #4 wires the real LLM call)
python memory-bench/harness_multi.py \
    --configs memory-bench-builtin \
    --tasks t01 \
    --reps 1

# print the config × task coverage matrix
python memory-bench/audit_coverage.py
```

## Registries

The canonical CONFIGS and TASKS are defined in `harness.py` and
documented in [`CONFIG_TASK_SET.md`](./CONFIG_TASK_SET.md). Summary:

- **8 configs**: `memory-bench-builtin`, `memory-bench-flowstate`,
  `memory-bench-ke`, `memory-bench-mem0`, `memory-bench-noledge`,
  `memory-bench-obsidian`, `memory-bench-plur`, `memory-bench-wiki`.
  `memory-bench-hermes` and `memory-bench-holographic` are excluded
  (they are control surfaces, not memory backends).
- **6 tasks**: `t01`…`t06` (mirrors `hermes-memory-bench/scripts/
  run_benchmark.py:TASK_IDS`).

## Adding a config (future slice)

The slice #3 registries are the source of truth. To add a new config in
a downstream slice (e.g. when a new memory backend ships):

1. Edit `harness.py` and append to `CONFIGS: List[str]`.
2. Mirror the new config in `CONFIG_TASK_SET.md`.
3. Update `EXPECTED_CONFIG_COUNT` in
   `tests/test_audit_coverage.py::test_registries_are_populated`.
4. Re-run the test suite.

## Idempotency

`harness.py` re-running on an already-initialized config dir does **not**
wipe prior runs unless `--force` is passed. Per-config, per-task
`runs/<config>/<task>/rep-<n>/` directories are created on demand.

## Out of scope (this slice)

- Registering any configs (slice #3)
- Selecting which tasks / configs are in scope (slice #1)
- Running real backfills (slice #4)
- Touching `~/.hermes/profiles/memory-bench-*` profiles (read-only)
