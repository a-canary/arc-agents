"""
Smoke + unit tests for the memory-bench scaffold.

Run with: ``python -m pytest memory-bench/tests/ -v``

We import the harness + audit modules directly (not as a package) and
exercise the public surface: registry count, matrix rendering, gate
behaviour, CLI filter contract, and idempotency.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

# Make the parent dir importable so we can import harness + audit_coverage
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import harness                # noqa: E402
import audit_coverage         # noqa: E402
import harness_multi          # noqa: E402


# ── Registry shape (scaffold contract) ──────────────────────────────────────
def test_registries_are_empty_in_scaffold():
    """Slice #3 owns the wiring. Until then, both registries are empty."""
    assert harness.CONFIGS == []
    assert harness.TASKS == []


# ── audit_coverage: matrix on the empty scaffold ────────────────────────────
def test_audit_empty_scaffold_exits_zero():
    """With CONFIGS=[] and TASKS=[], the matrix is empty and the gate is green."""
    md = audit_coverage.render_markdown([], [], [], threshold=3)
    # Always emits a parseable header + separator, even when empty.
    assert md.startswith("| config \\ task |")
    assert "|---|---|" in md

    rc = audit_coverage.main(["--quiet"])
    assert rc == 0


def test_audit_header_line_is_valid_markdown(tmp_path):
    """`audit_coverage.py | head -1` must print a valid Markdown table header."""
    result = subprocess.run(
        [sys.executable, str(ROOT / "audit_coverage.py")],
        capture_output=True, text=True, check=False,
    )
    # On the empty scaffold the renderer falls back to a placeholder header.
    first = result.stdout.splitlines()[0]
    assert first.startswith("|"), f"header not a markdown row: {first!r}"
    assert first.count("|") >= 3, f"too few pipes for a table row: {first!r}"


# ── audit_coverage: gate behaviour with injected runs ───────────────────────
def test_audit_exits_nonzero_when_a_cell_below_threshold(tmp_path):
    """Inject a single rep into a fake (config, task) cell by monkey-patching
    the registry. Threshold 1 → still covered. Threshold 2 → fails."""
    saved_c, saved_t = harness.CONFIGS, harness.TASKS
    try:
        harness.CONFIGS = ["fake-cfg"]
        harness.TASKS   = ["fake-t01"]

        # Stage a single rep dir with a result.json inside tmp_path.
        rep = tmp_path / "fake-cfg" / "fake-t01" / "rep-01"
        rep.mkdir(parents=True)
        (rep / "result.json").write_text(json.dumps({"task_id": "fake-t01"}))

        # threshold=1: cell has 1 rep, passes.
        rc_pass = audit_coverage.main(["--quiet", "--threshold", "1", "--runs-dir", str(tmp_path)])
        assert rc_pass == 0

        # threshold=2: cell has 1 rep, fails.
        rc_fail = audit_coverage.main(["--quiet", "--threshold", "2", "--runs-dir", str(tmp_path)])
        assert rc_fail == 1
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t


def test_audit_counts_reps_correctly(tmp_path):
    """count_reps() only counts dirs that contain a result.json."""
    # 3 valid reps + 1 stray dir without result.json.
    for i in (1, 2, 3):
        d = tmp_path / "cfg" / "t01" / f"rep-{i:02d}"
        d.mkdir(parents=True)
        (d / "result.json").write_text("{}")
    (tmp_path / "cfg" / "t01" / "rep-99").mkdir(parents=True)  # no result.json

    assert audit_coverage.count_reps("cfg", "t01", tmp_path) == 3


# ── matrix rendering ────────────────────────────────────────────────────────
def test_render_matrix_marks_below_threshold_cells(tmp_path):
    saved_c, saved_t = harness.CONFIGS, harness.TASKS
    try:
        harness.CONFIGS = ["a", "b"]
        harness.TASKS   = ["t1", "t2"]

        # a×t1=2 reps, a×t2=3 reps, b×t1=0, b×t2=5 reps
        for rep in (1, 2):
            (tmp_path / "a" / "t1" / f"rep-{rep:02d}").mkdir(parents=True)
            (tmp_path / "a" / "t1" / f"rep-{rep:02d}" / "result.json").write_text("{}")
        for rep in (1, 2, 3):
            (tmp_path / "a" / "t2" / f"rep-{rep:02d}").mkdir(parents=True)
            (tmp_path / "a" / "t2" / f"rep-{rep:02d}" / "result.json").write_text("{}")
        for rep in (1, 2, 3, 4, 5):
            (tmp_path / "b" / "t2" / f"rep-{rep:02d}").mkdir(parents=True)
            (tmp_path / "b" / "t2" / f"rep-{rep:02d}" / "result.json").write_text("{}")

        matrix = audit_coverage.build_matrix(harness.CONFIGS, harness.TASKS, tmp_path)
        md = audit_coverage.render_markdown(harness.CONFIGS, harness.TASKS, matrix, threshold=3)
        # a×t1=2 (⚠️), b×t1=0 (no mark), a×t2=3 ✅, b×t2=5 ✅
        assert "| a | 2 ⚠️ | 3 ✅ |" in md
        assert "| b | 0 | 5 ✅ |" in md
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t


# ── harness CLI surface ─────────────────────────────────────────────────────
def test_harness_help_exits_zero():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness.py"), "--help"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    assert "memory-bench" in result.stdout


def test_harness_list_configs_returns_empty():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness.py"), "--list-configs"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_harness_list_tasks_returns_empty():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness.py"), "--list-tasks"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


# ── harness_multi CLI surface ───────────────────────────────────────────────
def test_harness_multi_list_configs_returns_empty():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--list-configs"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_harness_multi_list_tasks_returns_empty():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--list-tasks"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_harness_multi_dry_run_empty_registry():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--dry-run"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    # No cells to print on an empty registry — every cell line has a tab
    # separating config \t task \t rep. Count those to confirm zero.
    cell_lines = [ln for ln in result.stdout.splitlines() if "\t" in ln]
    assert cell_lines == [], f"unexpected cell rows: {cell_lines}"


def test_harness_multi_filter_warns_on_unknown_config(capsys):
    """An unknown --configs entry is warned, not silently dropped or raised."""
    saved_c = list(harness.CONFIGS)
    try:
        harness.CONFIGS = ["known"]
        rc = harness_multi.main(["--list-configs", "--configs", "known,ghost"])
        captured = capsys.readouterr()
        assert rc == 0
        assert "known" in captured.out
        assert "ghost" in captured.err
    finally:
        harness.CONFIGS = saved_c


# ── Idempotency ─────────────────────────────────────────────────────────────
def test_run_one_idempotent(tmp_path, monkeypatch):
    """Two consecutive run_one() calls do not error or wipe the prior result."""
    saved_c, saved_t = harness.CONFIGS, harness.TASKS
    try:
        harness.CONFIGS = ["idem-cfg"]
        harness.TASKS   = ["idem-t01"]
        # Put a stub task file in TASKS_DIR so load_task() succeeds.
        (ROOT / "tasks").mkdir(exist_ok=True)
        task_file = ROOT / "tasks" / "idem-t01_stub.md"
        task_file.write_text("# stub task for idempotency test\n")
        # Redirect RUNS_DIR to tmp_path so we don't pollute the worktree.
        monkeypatch.setattr(harness, "RUNS_DIR", tmp_path)
        try:
            r1 = harness.run_one("idem-cfg", "idem-t01", 1)
            r2 = harness.run_one("idem-cfg", "idem-t01", 1)
            assert r1["error"] and "scaffold" in r1["error"]
            assert r2["error"] and "scaffold" in r2["error"]
            # The rep dir is still there, with a single result.json.
            rep = tmp_path / "idem-cfg" / "idem-t01" / "rep-01"
            assert rep.is_dir()
            assert (rep / "result.json").is_file()
        finally:
            task_file.unlink(missing_ok=True)
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t
