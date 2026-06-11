#!/usr/bin/env python3
"""
memory-bench — single-config single-task orchestrator

This is slice #3 (config + task registry wiring). It defines the CLI
surface, the run-dir layout, the per-run result schema, and the
canonical CONFIGS / TASKS registries used by `harness_multi.py` and
`audit_coverage.py`. Slice #4 wires the real LLM orchestrator on top.

The structural model is `hermes-memory-bench/scripts/run_benchmark.py`
(tmux + hermes chat pattern, JSONL result stream, summary.json writer).

## Registries

CONFIGS — the 8 `memory-bench-*` Hermes profiles registered for the
memory-bench sweep. `hermes-baseline` and `holographic-baseline` are
intentionally excluded; see `CONFIG_TASK_SET.md` for the rationale.

TASKS — the 6 canonical complex-reasoning tasks mirrored from
`hermes-memory-bench/scripts/run_benchmark.py:TASK_IDS`. Each task
is a Markdown file under `tasks/<task_id>*.md`.
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
HERMES_HOME  = Path.home() / ".hermes"
PROFILES_DIR = HERMES_HOME / "profiles"

# Canonical registries. Source of truth: see `CONFIG_TASK_SET.md` and
# the slice #3 PR description. Mirror of `hermes-memory-bench/scripts/
# run_benchmark.py:TASK_IDS` for tasks; the 8-config set excludes
# memory-bench-hermes and memory-bench-holographic per the slice brief.
CONFIGS: List[str] = [
    "memory-bench-builtin",
    "memory-bench-flowstate",
    "memory-bench-ke",
    "memory-bench-mem0",
    "memory-bench-noledge",
    "memory-bench-obsidian",
    "memory-bench-plur",
    "memory-bench-wiki",
]

TASKS: List[str] = [
    "t01",  # Multi-Hop Reasoning Chain
    "t02",  # Research Gap Analysis & Literature Synthesis
    "t03",  # Counterfactual Design Critique
    "t04",  # Archival Knowledge Retrieval Under Degradation
    "t05",  # Cross-Temporal Analogical Reasoning
    "t06",  # Error Propagation Analysis in Multi-Agent Pipelines
]

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
def isolate_profile_workspace(config: str) -> None:
    """Wipe the config's hermes profile workspace before a run.

    Per the slice #3 config-isolation guarantee: a backfill for config X
    must NEVER touch another config's state. This function only operates
    on the path ``~/.hermes/profiles/<config>/``; it asserts the
    resolved path is a direct child of PROFILES_DIR with a registered
    config name so a malformed config string can't escape the
    profiles root.
    """
    if config not in CONFIGS:
        raise ValueError(f"refuse to wipe unknown config: {config!r}")
    profile_root = (PROFILES_DIR / config).resolve()
    profiles_root = PROFILES_DIR.resolve()
    # Defence-in-depth: profile_root must be a direct child of profiles_root.
    if profile_root.parent != profiles_root:
        raise RuntimeError(
            f"refuse to wipe: {profile_root} is not a direct child of {profiles_root}"
        )
    if not profile_root.exists():
        # No profile on this machine yet — nothing to wipe.
        return
    workspace = profile_root / "workspace"
    if workspace.is_dir():
        shutil.rmtree(workspace)
    log(f"isolate: wiped {workspace}")


def run_one(config: str, task_id: str, rep: int, *, force: bool = False) -> dict:
    """Run a single (config, task, rep) cell.

    Config isolation: wipes the config's own hermes profile workspace
    (idempotent, in-place — never touches another config's state) and
    the rep dir (when ``force=True``). Returns a stub result without
    invoking Hermes — the real LLM orchestrator lands in slice #4.
    """
    log(f"run_one({config}, {task_id}, rep={rep}) — slice #3 stub")
    rd = run_dir(config, task_id, rep, force=force)
    try:
        isolate_profile_workspace(config)
    except Exception as e:
        result = make_result(task_id, config, rep, 0.0,
                             error=f"isolate: {e}")
        write_result(rd, result)
        return result
    try:
        task_content = load_task(task_id)
    except FileNotFoundError as e:
        result = make_result(task_id, config, rep, 0.0, error=str(e))
        write_result(rd, result)
        return result

    start = time.time()
    # Slice #3: no LLM call. Mark with a clear sentinel.
    elapsed_ms = (time.time() - start) * 1000.0
    result = make_result(
        task_id, config, rep, elapsed_ms,
        error="slice-#3: orchestrator stub (slice #4 wires the LLM call)",
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
