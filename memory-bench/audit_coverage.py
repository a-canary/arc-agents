#!/usr/bin/env python3
"""
memory-bench — config × task coverage auditor (scaffold)

Walks the ``runs/`` tree, counts per-(config, task) rep dirs that contain
a ``result.json``, and prints a Markdown matrix. Exits non-zero if any
cell is below ``--threshold`` (default 3 — the PRD's "covered" floor).

The scaffold reads the registries from ``harness.py``. With both
``CONFIGS`` and ``TASKS`` empty (current state), the matrix is 0×0 and
the script exits 0.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402

RUNS_DIR = harness.RUNS_DIR
DEFAULT_THRESHOLD = 3


# ── Counting ────────────────────────────────────────────────────────────────
def count_reps(config: str, task_id: str, runs_dir: Path) -> int:
    """Count rep dirs under runs/<config>/<task_id>/ that have a result.json."""
    base = runs_dir / config / task_id
    if not base.is_dir():
        return 0
    n = 0
    for rep_dir in base.iterdir():
        if rep_dir.is_dir() and (rep_dir / "result.json").is_file():
            n += 1
    return n


def build_matrix(configs: List[str], tasks: List[str],
                 runs_dir: Path) -> List[List[int]]:
    return [[count_reps(c, t, runs_dir) for t in tasks] for c in configs]


# ── Markdown rendering ──────────────────────────────────────────────────────
def render_markdown(configs: List[str], tasks: List[str],
                    matrix: List[List[int]], threshold: int) -> str:
    """Return a Markdown table. Always emits a header row + separator."""
    if not configs or not tasks:
        # Emit an empty-but-valid header so consumers can parse it.
        return "| config \\ task | (no tasks registered) |\n|---|---|"

    header = "| config \\ task | " + " | ".join(tasks) + " |"
    sep    = "|" + "|".join(["---"] * (len(tasks) + 1)) + "|"
    rows   = [header, sep]
    for c, row in zip(configs, matrix):
        cells = []
        for n in row:
            mark = " ✅" if n >= threshold and n > 0 else (" ⚠️" if n > 0 else "")
            cells.append(f"{n}{mark}")
        rows.append(f"| {c} | " + " | ".join(cells) + " |")
    return "\n".join(rows) + "\n"


# ── CLI ─────────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="audit_coverage.py",
        description="Print the config × task rep-count matrix and exit non-zero "
                    "if any cell is below --threshold.",
    )
    p.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD,
                   help=f"min rep count per cell (default {DEFAULT_THRESHOLD})")
    p.add_argument("--runs-dir", type=Path, default=RUNS_DIR,
                   help=f"override the runs/ directory (default {RUNS_DIR})")
    p.add_argument("--quiet", action="store_true",
                   help="suppress the matrix; only print the gate verdict")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    configs = list(harness.CONFIGS)
    tasks   = list(harness.TASKS)
    matrix  = build_matrix(configs, tasks, args.runs_dir)

    if not args.quiet:
        sys.stdout.write(render_markdown(configs, tasks, matrix, args.threshold))

    # Gate: any cell below threshold → exit 1.
    failing = [(c, t, n)
               for c, row in zip(configs, matrix)
               for t, n in zip(tasks, row)
               if n < args.threshold]

    if failing:
        sys.stderr.write(
            f"audit_coverage: {len(failing)} cell(s) below threshold {args.threshold}:\n"
        )
        for c, t, n in failing:
            sys.stderr.write(f"  {c} × {t} = {n}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
