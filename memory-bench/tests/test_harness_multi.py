"""
Tests for `harness_multi.py` — the multi-config orchestrator.

Exercises the slice #3 acceptance criteria:

  - ``--configs`` / ``--tasks`` filters intersect the registry
  - ``--dry-run`` prints the would-execute matrix without API calls
  - ``--list-configs`` / ``--list-tasks`` reflect the post-filter sets
  - Idempotency + config isolation hold across consecutive runs
  - Cross-config isolation: a run for config X never touches profile Y

Run with: ``python -m pytest memory-bench/tests/test_harness_multi.py -v``
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import harness          # noqa: E402
import harness_multi    # noqa: E402


# ── Registry intersection (--configs / --tasks filters) ────────────────────
def test_apply_filters_returns_full_registry_by_default():
    """No filters → the full CONFIGS × TASKS cross product."""
    cfgs, tsks = harness_multi.apply_filters(None, None)
    assert cfgs == list(harness.CONFIGS)
    assert tsks == list(harness.TASKS)


def test_apply_filters_intersects_known_subset():
    saved_c, saved_t = list(harness.CONFIGS), list(harness.TASKS)
    try:
        harness.CONFIGS = ["a", "b", "c"]
        harness.TASKS   = ["t1", "t2"]
        cfgs, tsks = harness_multi.apply_filters(["a", "c"], ["t2"])
        assert cfgs == ["a", "c"]
        assert tsks == ["t2"]
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t


def test_apply_filters_warns_on_unknown_id(capsys):
    """An unknown --configs/--tasks id is warned, not raised."""
    saved_c, saved_t = list(harness.CONFIGS), list(harness.TASKS)
    try:
        harness.CONFIGS = ["known"]
        harness.TASKS   = ["known-t"]
        cfgs, tsks = harness_multi.apply_filters(["known", "ghost"], ["known-t", "nope"])
        captured = capsys.readouterr()
        assert "ghost" in captured.err
        assert "nope" in captured.err
        assert cfgs == ["known"]
        assert tsks == ["known-t"]
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t


# ── CLI surface (subprocess-driven, hits the actual script) ────────────────
def test_multi_list_configs_matches_registry():
    r = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--list-configs"],
        capture_output=True, text=True, check=False,
    )
    assert r.returncode == 0
    assert [ln for ln in r.stdout.splitlines() if ln.strip()] == list(harness.CONFIGS)


def test_multi_list_tasks_matches_registry():
    r = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--list-tasks"],
        capture_output=True, text=True, check=False,
    )
    assert r.returncode == 0
    assert [ln for ln in r.stdout.splitlines() if ln.strip()] == list(harness.TASKS)


def test_multi_list_configs_post_filter():
    r = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"),
         "--list-configs", "--configs", "memory-bench-ke"],
        capture_output=True, text=True, check=False,
    )
    assert r.returncode == 0
    assert r.stdout.strip() == "memory-bench-ke"


def test_multi_list_tasks_post_filter():
    r = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"),
         "--list-tasks", "--tasks", "t01,t03"],
        capture_output=True, text=True, check=False,
    )
    assert r.returncode == 0
    assert r.stdout.splitlines() == ["t01", "t03"]


# ── --dry-run contract ──────────────────────────────────────────────────────
def test_dry_run_prints_full_matrix_when_no_filters():
    """No filters + --reps 1 → cell count = |CONFIGS| × |TASKS| × 1."""
    r = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--dry-run"],
        capture_output=True, text=True, check=False,
    )
    assert r.returncode == 0
    cells = [ln for ln in r.stdout.splitlines() if "\t" in ln]
    assert len(cells) == len(harness.CONFIGS) * len(harness.TASKS)
    # Each cell line: <config>\t<task>\trep-NN
    for line in cells:
        parts = line.split("\t")
        assert len(parts) == 3
        cfg, task, rep = parts
        assert cfg in harness.CONFIGS
        assert task in harness.TASKS
        assert rep.startswith("rep-")


def test_dry_run_honours_filters_and_reps():
    """--configs X,Y --tasks A,B --reps 3 → exactly 12 cells (2×2×3)."""
    cfgs = "memory-bench-builtin,memory-bench-ke"
    tsks = "t01,t02"
    r = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"),
         "--dry-run", "--configs", cfgs, "--tasks", tsks, "--reps", "3"],
        capture_output=True, text=True, check=False,
    )
    assert r.returncode == 0
    cells = [ln for ln in r.stdout.splitlines() if "\t" in ln]
    assert len(cells) == 2 * 2 * 3, f"expected 12 cells, got {len(cells)}"
    # Verify the rep suffix rotation
    reps_seen = sorted({ln.split("\t")[2] for ln in cells})
    assert reps_seen == ["rep-01", "rep-02", "rep-03"]


def test_dry_run_makes_no_writes(tmp_path, monkeypatch):
    """--dry-run must NOT create any runs/<config>/<task>/rep-N/ dirs."""
    # Run with --dry-run under a redirected RUNS_DIR; nothing should appear.
    monkeypatch.setattr(harness, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(harness_multi, "RUNS_DIR", tmp_path)
    r = harness_multi.main([
        "--dry-run",
        "--configs", "memory-bench-builtin",
        "--tasks", "t01",
    ])
    assert r == 0
    # No rep dirs were created.
    assert list(tmp_path.rglob("rep-*")) == []


# ── Live 1×1 run: --configs X --tasks A --reps 1 ──────────────────────────
def test_live_1x1_run_writes_result_and_rep_dir(tmp_path, monkeypatch):
    """A 1×1 live run (no --dry-run) writes result.json + rep dir."""
    saved_c, saved_t = list(harness.CONFIGS), list(harness.TASKS)
    monkeypatch.setattr(harness, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(harness_multi, "RUNS_DIR", tmp_path)
    try:
        harness.CONFIGS = ["memory-bench-builtin"]
        harness.TASKS   = ["t01"]
        rc = harness_multi.main([
            "--configs", "memory-bench-builtin",
            "--tasks", "t01",
            "--reps", "1",
        ])
        # Slice #3 stub returns an error sentinel; that's expected.
        # What matters is the on-disk artefacts.
        rep = tmp_path / "memory-bench-builtin" / "t01" / "rep-01"
        assert rep.is_dir(), f"rep dir not created at {rep}"
        result = rep / "result.json"
        assert result.is_file()
        data = json.loads(result.read_text())
        assert data["task_id"] == "t01"
        assert data["config"] == "memory-bench-builtin"
        assert data["rep"] == 1
        assert data["error"], "slice #3 stub should mark the result as an error"
        assert "slice-#3" in data["error"]
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t


# ── Config isolation guarantee ─────────────────────────────────────────────
def test_isolate_profile_workspace_refuses_unknown_config():
    """The isolation helper must refuse to wipe an unregistered config —
    this is the second line of defence against cross-config contamination."""
    with pytest.raises(ValueError, match="unknown config"):
        harness.isolate_profile_workspace("definitely-not-registered")


def test_isolate_profile_workspace_refuses_escape_path(monkeypatch, tmp_path):
    """A `config` that escapes the profiles/ root must be rejected."""
    # Monkey-patch CONFIGS to admit a path-traversal-shaped name.
    saved = list(harness.CONFIGS)
    try:
        harness.CONFIGS = ["memory-bench-builtin", "../escape"]
        with pytest.raises(RuntimeError, match="not a direct child"):
            harness.isolate_profile_workspace("../escape")
    finally:
        harness.CONFIGS = saved


def test_run_one_never_touches_another_configs_runs(monkeypatch, tmp_path):
    """A run for config X must not create or wipe config Y's rep dir."""
    saved_c, saved_t = list(harness.CONFIGS), list(harness.TASKS)
    monkeypatch.setattr(harness, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(harness_multi, "RUNS_DIR", tmp_path)
    try:
        harness.CONFIGS = ["cfg-x", "cfg-y"]
        harness.TASKS   = ["t01"]
        # Stage a pre-existing result for cfg-y; it must survive.
        y_rep = tmp_path / "cfg-y" / "t01" / "rep-01"
        y_rep.mkdir(parents=True)
        (y_rep / "result.json").write_text(json.dumps({"task_id": "t01", "config": "cfg-y", "rep": 1}))

        harness.run_one("cfg-x", "t01", 1)

        # cfg-y's result is untouched.
        y_result = json.loads((y_rep / "result.json").read_text())
        assert y_result["config"] == "cfg-y"
        # cfg-x got its own rep dir; cfg-y did not get a new one.
        assert (tmp_path / "cfg-x" / "t01" / "rep-01" / "result.json").is_file()
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t
