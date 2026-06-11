#!/usr/bin/env python3
"""
memory-bench — single-config single-task orchestrator (scaffold)

This is the scaffold slice. It defines the CLI surface, the run-dir
layout, and the per-run result schema. The actual config registry
(CONFIGS, TASKS) is intentionally empty here — slice #3 wires the
8-10 memory-bench-* profiles in.

The structural model is `hermes-memory-bench/scripts/run_benchmark.py`
(tmux + hermes chat pattern, JSONL result stream, summary.json writer).
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

# ── Constants ───────────────────────────────────────────────────────────────
BENCH_BASE   = Path(__file__).resolve().parent
TASKS_DIR    = BENCH_BASE / "tasks"
RUNS_DIR     = BENCH_BASE / "runs"
SCRIPTS_DIR  = BENCH_BASE

# Stub registries — slice #3 fills these.
CONFIGS: List[str] = []
TASKS:   List[str] = []

TIMEOUT_SEC = 600


# ── Helpers ─────────────────────────────────────────────────────────────────
def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_task(task_id: str) -> str:
    """Load task content from tasks/<task_id>*.md. Raises if not found."""
    matches = sorted(TASKS_DIR.glob(f"{task_id}*"))
    if not matches:
        raise FileNotFoundError(f"No task file for {task_id} in {TASKS_DIR}")
    return matches[0].read_text(encoding="utf-8")


def run_dir(config: str, task_id: str, rep: int, *, force: bool = False) -> Path:
    """Return runs/<config>/<task_id>/rep-<n>/, creating if absent.

    Idempotent: existing rep dirs are kept unless ``force=True``.
    """
    rd = RUNS_DIR / config / task_id / f"rep-{rep:02d}"
    if force and rd.exists():
        shutil.rmtree(rd)
    rd.mkdir(parents=True, exist_ok=True)
    return rd


def make_result(task_id: str, config: str, rep: int, wall_ms: float,
                *, error: Optional[str] = None,
                tokens_in: int = 0, tokens_out: int = 0,
                requests: int = 0, cache_hits: int = 0,
                response_text: str = "") -> dict:
    return {
        "task_id":       task_id,
        "config":        config,
        "rep":           rep,
        "wall_time_ms":  round(wall_ms, 1),
        "tokens_in":     tokens_in,
        "tokens_out":    tokens_out,
        "requests":      requests,
        "cache_hits":    cache_hits,
        "quality_score": 0.0,
        "error":         error,
        "response_text": response_text,
        "timestamp":     now_iso(),
    }


def write_result(rd: Path, result: dict) -> None:
    """Write the canonical result.json + append to the JSONL stream."""
    (rd / "result.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    jsonl = RUNS_DIR / "results.jsonl"
    with jsonl.open("a", encoding="utf-8") as f:
        f.write(json.dumps(result, ensure_ascii=False) + "\n")


# ── Orchestration (stub) ────────────────────────────────────────────────────
def run_one(config: str, task_id: str, rep: int, *, force: bool = False) -> dict:
    """Run a single (config, task, rep) cell.

    The scaffold returns a stub result without invoking Hermes — the
    real orchestration is wired in slice #3 / slice #4 alongside the
    config registry.
    """
    log(f"run_one({config}, {task_id}, rep={rep}) — scaffold stub")
    rd = run_dir(config, task_id, rep, force=force)
    try:
        task_content = load_task(task_id)
    except FileNotFoundError as e:
        result = make_result(task_id, config, rep, 0.0, error=str(e))
        write_result(rd, result)
        return result

    start = time.time()
    # Scaffold: no LLM call. Mark with a clear sentinel.
    elapsed_ms = (time.time() - start) * 1000.0
    result = make_result(
        task_id, config, rep, elapsed_ms,
        error="scaffold: no orchestrator wired (slice #3)",
        response_text=task_content[:200],
    )
    write_result(rd, result)
    return result


# ── CLI ─────────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="harness.py",
        description="memory-bench single-config single-task orchestrator (scaffold).",
    )
    p.add_argument("--config", default=None, help="config name (slice #3 wires the registry)")
    p.add_argument("--task",   default=None, help="task id (e.g. t01)")
    p.add_argument("--rep",    type=int, default=1, help="replicate number (1-based)")
    p.add_argument("--force",  action="store_true", help="wipe the rep dir before running")
    p.add_argument("--list-configs", action="store_true", help="print registered configs and exit")
    p.add_argument("--list-tasks",   action="store_true", help="print registered tasks and exit")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    if args.list_configs:
        for c in CONFIGS:
            print(c)
        return 0
    if args.list_tasks:
        for t in TASKS:
            print(t)
        return 0

    if not args.config or not args.task:
        build_parser().print_help()
        return 2

    if args.config not in CONFIGS:
        log(f"unknown config: {args.config} (registered: {CONFIGS})")
        return 2
    if args.task not in TASKS:
        log(f"unknown task: {args.task} (registered: {TASKS})")
        return 2

    result = run_one(args.config, args.task, args.rep, force=args.force)
    if result["error"]:
        log(f"ERROR: {result['error'][:120]}")
        return 1
    log(f"OK — rep={args.rep} wall={result['wall_time_ms']:.1f}ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
