#!/usr/bin/env python3
"""
memory-bench — multi-config orchestrator (scaffold)

Slurps the config + task registries from `harness.py` and runs the
cross product, optionally filtered by ``--configs`` and/or ``--tasks``.
Slice #3 wires the registries; this scaffold makes the CLI surface
and the filter contract stable.

Idempotent: a (config, task, rep) cell that has a result.json already
is skipped unless ``--force`` is passed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional, Sequence

# Local import — keep registries co-located with harness.py
sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402

RUNS_DIR = harness.RUNS_DIR


# ── CLI helpers ─────────────────────────────────────────────────────────────
def _csv(value: str) -> List[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="harness_multi.py",
        description="memory-bench multi-config orchestrator (scaffold).",
    )
    p.add_argument("--configs", type=_csv, default=None,
                   help="comma-separated config filter (default: all registered)")
    p.add_argument("--tasks", type=_csv, default=None,
                   help="comma-separated task filter (default: all registered)")
    p.add_argument("--reps", type=int, default=1,
                   help="replicate count per (config, task) cell (default 1)")
    p.add_argument("--force", action="store_true",
                   help="wipe existing rep dirs before running")
    p.add_argument("--list-configs", action="store_true",
                   help="print registered configs (post-filter) and exit")
    p.add_argument("--list-tasks", action="store_true",
                   help="print registered tasks (post-filter) and exit")
    p.add_argument("--dry-run", action="store_true",
                   help="print the matrix that would run and exit")
    return p


def apply_filters(configs: Optional[Sequence[str]],
                  tasks:   Optional[Sequence[str]]
                  ) -> tuple[List[str], List[str]]:
    """Intersect user filters with the registry. Warns on unknown ids."""
    reg_configs = list(harness.CONFIGS)
    reg_tasks   = list(harness.TASKS)

    if configs is not None:
        unknown = [c for c in configs if c not in reg_configs]
        if unknown:
            print(f"warning: unknown configs ignored: {unknown}", file=sys.stderr)
        configs = [c for c in configs if c in reg_configs]
    else:
        configs = reg_configs

    if tasks is not None:
        unknown = [t for t in tasks if t not in reg_tasks]
        if unknown:
            print(f"warning: unknown tasks ignored: {unknown}", file=sys.stderr)
        tasks = [t for t in tasks if t in reg_tasks]
    else:
        tasks = reg_tasks

    return list(configs), list(tasks)


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    configs, tasks = apply_filters(args.configs, args.tasks)

    if args.list_configs:
        for c in configs:
            print(c)
        return 0
    if args.list_tasks:
        for t in tasks:
            print(t)
        return 0

    total = len(configs) * len(tasks) * max(args.reps, 1)
    harness.log(f"multi-config scaffold — configs={configs} tasks={tasks} reps={args.reps} total_cells={total}")
    if args.dry_run:
        for c in configs:
            for t in tasks:
                for r in range(1, args.reps + 1):
                    print(f"{c}\t{t}\trep-{r:02d}")
        return 0

    if not configs or not tasks:
        harness.log("nothing to run (empty registry — slice #3 not yet wired)")
        return 0

    rc = 0
    for c in configs:
        for t in tasks:
            for r in range(1, args.reps + 1):
                result = harness.run_one(c, t, r, force=args.force)
                if result.get("error"):
                    rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
