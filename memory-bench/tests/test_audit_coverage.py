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


# ── Registry shape (slice #3 contract) ─────────────────────────────────────
# Slice #3 wires the canonical 8 configs and 6 tasks. The exact
# contents are the source of truth — see `CONFIG_TASK_SET.md`. These
# tests guard the shape (count, prefixes, uniqueness) so a future edit
# can't silently drop a config or task without a test failure.

EXPECTED_CONFIG_COUNT = 8
EXPECTED_TASK_COUNT = 6


def test_registries_are_populated():
    """Slice #3 wires 8 configs and 6 tasks; see CONFIG_TASK_SET.md."""
    assert len(harness.CONFIGS) == EXPECTED_CONFIG_COUNT, (
        f"expected {EXPECTED_CONFIG_COUNT} configs, got {len(harness.CONFIGS)}: "
        f"{harness.CONFIGS}"
    )
    assert len(harness.TASKS) == EXPECTED_TASK_COUNT, (
        f"expected {EXPECTED_TASK_COUNT} tasks, got {len(harness.TASKS)}: "
        f"{harness.TASKS}"
    )


def test_config_names_use_canonical_prefix():
    """Every registered config must start with `memory-bench-`."""
    for c in harness.CONFIGS:
        assert c.startswith("memory-bench-"), f"non-canonical config name: {c!r}"


def test_task_ids_use_t_prefix():
    """Every registered task must start with `t` followed by 2 digits."""
    import re
    pat = re.compile(r"^t\d{2}$")
    for t in harness.TASKS:
        assert pat.match(t), f"non-canonical task id: {t!r}"


def test_registries_have_no_duplicates():
    assert len(harness.CONFIGS) == len(set(harness.CONFIGS)), \
        f"duplicate configs: {harness.CONFIGS}"
    assert len(harness.TASKS) == len(set(harness.TASKS)), \
        f"duplicate tasks: {harness.TASKS}"


def test_hermes_and_holographic_excluded_by_default():
    """The 8-config default excludes `memory-bench-hermes` and
    `memory-bench-holographic` per the slice brief and CONFIG_TASK_SET.md."""
    assert "memory-bench-hermes" not in harness.CONFIGS
    assert "memory-bench-holographic" not in harness.CONFIGS


def test_task_files_exist_on_disk():
    """Every registered task must have a Markdown file in tasks/."""
    for t in harness.TASKS:
        matches = sorted(harness.TASKS_DIR.glob(f"{t}*"))
        assert matches, f"no task file for {t} in {harness.TASKS_DIR}"


# ── audit_coverage: matrix on the empty registry ───────────────────────────
def test_audit_empty_registry_renders_placeholder_header():
    """With CONFIGS=[] and TASKS=[], the renderer emits a valid placeholder
    header (no cells). The full registry's run-state is exercised by the
    scaffold-acceptance tests below."""
    md = audit_coverage.render_markdown([], [], [], threshold=3)
    # Always emits a parseable header + separator, even when empty.
    assert md.startswith("| config \\ task |")
    assert "|---|---|" in md


def test_audit_full_registry_exits_nonzero_with_no_runs():
    """The wired registry (8 configs × 6 tasks) is populated but the
    runs/ tree is empty → 48 cells below threshold → exit 1."""
    rc = audit_coverage.main(["--quiet", "--runs-dir", str(ROOT / "runs")])
    assert rc == 1


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


def test_harness_list_configs_returns_all_registered():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness.py"), "--list-configs"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    out = [ln for ln in result.stdout.splitlines() if ln.strip()]
    assert out == list(harness.CONFIGS)


def test_harness_list_tasks_returns_all_registered():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness.py"), "--list-tasks"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    out = [ln for ln in result.stdout.splitlines() if ln.strip()]
    assert out == list(harness.TASKS)


# ── harness_multi CLI surface ───────────────────────────────────────────────
def test_harness_multi_list_configs_returns_all_registered():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--list-configs"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    out = [ln for ln in result.stdout.splitlines() if ln.strip()]
    assert out == list(harness.CONFIGS)


def test_harness_multi_list_tasks_returns_all_registered():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--list-tasks"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    out = [ln for ln in result.stdout.splitlines() if ln.strip()]
    assert out == list(harness.TASKS)


def test_harness_multi_dry_run_walks_full_matrix():
    result = subprocess.run(
        [sys.executable, str(ROOT / "harness_multi.py"), "--dry-run"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    # Each cell line is `<config>\t<task>\trep-NN`. With 1 rep default
    # the count equals |CONFIGS| * |TASKS|.
    cell_lines = [ln for ln in result.stdout.splitlines() if "\t" in ln]
    expected = len(harness.CONFIGS) * len(harness.TASKS) * 1
    assert len(cell_lines) == expected, (
        f"expected {expected} cell rows, got {len(cell_lines)}: {cell_lines[:3]}…"
    )


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
            # Slice #3 marks the no-orchestrator case with a different
            # sentinel than the slice #2 "scaffold" message.
            assert r1["error"] and "slice-#3" in r1["error"]
            assert r2["error"] and "slice-#3" in r2["error"]
            # The rep dir is still there, with a single result.json.
            rep = tmp_path / "idem-cfg" / "idem-t01" / "rep-01"
            assert rep.is_dir()
            assert (rep / "result.json").is_file()
        finally:
            task_file.unlink(missing_ok=True)
    finally:
        harness.CONFIGS, harness.TASKS = saved_c, saved_t
