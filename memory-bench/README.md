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
| 2 | **scaffold the tree** (this slice) | **done** |
| 3 | wire the 8 configs into `harness.py` | not started |
| 4 | statistics + Elo writers + backfill runner | not started |

## Quick start

```bash
# smoke — empty scaffold, expect exit 0 and a header
python memory-bench/audit_coverage.py

# run the smoke test
python -m pytest memory-bench/tests/ -v

# help on the orchestrators
python memory-bench/harness.py --help
python memory-bench/harness_multi.py --list-configs    # → []
python memory-bench/harness_multi.py --list-tasks      # → []
```

## Adding a config (slice #3)

Once the 8-config list is fixed, edit `harness.py` and replace the stub
registries with the real names:

```python
CONFIGS: List[str] = [
    "memory-bench-builtin",
    "memory-bench-flowstate",
    "memory-bench-plur",
    "memory-bench-wiki",
    # ... 4-6 more
]
TASKS: List[str] = ["t01", "t02", "t03", "t04", "t05"]
```

Then `harness_multi.py --list-configs` will print the registered names
and `audit_coverage.py` will size the matrix accordingly.

## Idempotency

`harness.py` re-running on an already-initialized config dir does **not**
wipe prior runs unless `--force` is passed. Per-config, per-task
`runs/<config>/<task>/rep-<n>/` directories are created on demand.

## Out of scope (this slice)

- Registering any configs (slice #3)
- Selecting which tasks / configs are in scope (slice #1)
- Running real backfills (slice #4)
- Touching `~/.hermes/profiles/memory-bench-*` profiles (read-only)
