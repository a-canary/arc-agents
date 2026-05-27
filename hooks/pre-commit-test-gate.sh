#!/usr/bin/env bash
# pre-commit-test-gate.sh — runs tests/typecheck before commit on release branches.
#
# Gates (in order):
#   1. branch-gate  — skip unless on main, release/*, or a PR head branch
#   2. typecheck    — bun run typecheck (fast, non-optional when gate is active)
#   3. test         — bun test (block on failure)
#
# Usage: add to .git/hooks/pre-commit (or call via hooks/pre-commit.d/)
# Bypass: PRECOMMIT_SKIP=1 git commit ...
# Skip tests only: PRECOMMIT_SKIP_TEST=1 git commit ...
# Skip typecheck only: PRECOMMIT_SKIP_TYPECHECK=1 git commit ...

set -euo pipefail

# ── Bypass ───────────────────────────────────────────────────────────────────

if [[ "${PRECOMMIT_SKIP:-0}" == "1" ]]; then
  exit 0
fi

# ── Branch Gate ───────────────────────────────────────────────────────────────
# Activate only on: main, release/*, or when HEAD is a PR branch.

activate_gate() {
  local branch
  branch="$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo unknown)"

  case "$branch" in
    main|master) return 0 ;;
    release/*)   return 0 ;;
    *)
      # If origin/main exists and HEAD is not based on it, skip gate
      # (feature branch not targeting main/release)
      if git rev-parse --verify origin/main >/dev/null 2>&1; then
        if git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
          # HEAD is based on main — gate activates (catch stray release-scope commits)
          return 0
        else
          return 1
        fi
      fi
      # No remote — gate activates on any branch to be safe
      return 0
      ;;
  esac
}

if ! activate_gate; then
  # Fast path: not a release branch, skip gate
  exit 0
fi

PROJECT="$(git rev-parse --show-toplevel)"
cd "$PROJECT"

log() { echo "[pre-commit-test-gate $(date +%H%M)] $*" >&2; }
run_cmd() {
  local cmd="$1"
  local timeout_s="${2:-60}"
  timeout "$timeout_s" bash -c "$cmd" >/dev/null 2>&1
}

failed=0

# ── Gate 1: Typecheck ─────────────────────────────────────────────────────────

if [[ "${PRECOMMIT_SKIP_TYPECHECK:-0}" != "1" ]]; then
  log "Typecheck gate"
  if run_cmd "cd '$PROJECT' && bun run typecheck" 120; then
    echo "pre-commit-test-gate: typecheck PASS"
  else
    echo "pre-commit-test-gate: typecheck FAIL" >&2
    echo "  bypass with: PRECOMMIT_SKIP_TYPECHECK=1 git commit ..." >&2
    failed=1
  fi
else
  echo "pre-commit-test-gate: typecheck SKIP (PRECOMMIT_SKIP_TYPECHECK=1)"
fi

# ── Gate 2: Test ─────────────────────────────────────────────────────────────

if [[ "${PRECOMMIT_SKIP_TEST:-0}" != "1" ]]; then
  log "Test gate"
  if ! command -v bun >/dev/null 2>&1; then
    echo "pre-commit-test-gate: test SKIP (bun not on PATH)" >&2
  elif run_cmd "cd '$PROJECT' && bun test" 180; then
    echo "pre-commit-test-gate: test PASS"
  else
    echo "pre-commit-test-gate: test FAIL" >&2
    echo "  bypass with: PRECOMMIT_SKIP_TEST=1 git commit ..." >&2
    failed=1
  fi
else
  echo "pre-commit-test-gate: test SKIP (PRECOMMIT_SKIP_TEST=1)"
fi

if (( failed )); then
  echo "pre-commit-test-gate: FAIL — commit blocked. Fix failures or bypass above." >&2
  exit 1
fi

echo "pre-commit-test-gate: all gates PASS"
exit 0