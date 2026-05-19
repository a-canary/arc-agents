#!/bin/bash
# merge-gate.sh — pipeline merge gate validation for arc-agents (Bun/TS).
#
# Gates (in order, all run; non-zero exit if any FAIL):
#   1. fixture   — at least one *.test.ts colocated test exists
#   2. typecheck — `bun run typecheck` passes (tsc --noEmit)
#   3. test      — `bun test` passes (full suite, bun's runner)
#   4. author    — `bin/lint-no-hardcoded-author.sh` clean (I-0006)
#
# Usage: bin/merge-gate.sh [--project <path>]
#   PROJECT env var or --project overrides cwd. Defaults to repo containing this script.
# Output: per-gate JSON lines to stdout, then SUMMARY block. Exit 0 iff all gates PASS/SKIP.
#
# Aligned with G-0005 (one-slice-per-worktree) + G-0008 (Bun/TS default).
# Port of ~/agents/bin/merge-gate.sh adapted for Bun runtime (was tsx/vitest).

set -euo pipefail

# Resolve --project flag
PROJECT="${PROJECT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$PROJECT" ]; then
  PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

BRANCH="$(cd "$PROJECT" && git branch --show-current 2>/dev/null || echo unknown)"
HEAD_HASH="$(cd "$PROJECT" && git rev-parse HEAD 2>/dev/null || echo unknown)"
RESULTS=()

# ── Helpers ─────────────────────────────────────────────────────────────────

pass() { echo "{\"gate\":\"$1\",\"status\":\"PASS\",\"detail\":\"$2\"}"; RESULTS+=("PASS:$1"); }
fail() { echo "{\"gate\":\"$1\",\"status\":\"FAIL\",\"detail\":\"$2\"}"; RESULTS+=("FAIL:$1"); }
skip() { echo "{\"gate\":\"$1\",\"status\":\"SKIP\",\"detail\":\"$2\"}"; RESULTS+=("SKIP:$1"); }

log() { echo "[merge-gate $(date +%H%M)] $*" >&2; }

run_cmd() {
  local cmd="$1"
  local timeout_s="${2:-60}"
  timeout "$timeout_s" bash -c "$cmd" >/dev/null 2>&1
}

# ── Gate 1: Fixture — *.test.ts files exist ─────────────────────────────────

gate_fixture() {
  log "Gate 1: Fixture"
  local count
  count=$(find "$PROJECT" \( -name node_modules -o -name .git -o -name worktrees \) -prune -o \
    -name '*.test.ts' -print 2>/dev/null | wc -l)
  if [ "$count" -eq 0 ]; then
    fail "fixture" "No *.test.ts files found in $PROJECT"
    return 1
  fi
  pass "fixture" "Found $count test file(s)"
}

# ── Gate 2: Typecheck — bun run typecheck ───────────────────────────────────

gate_typecheck() {
  log "Gate 2: Typecheck"
  if ! [ -f "$PROJECT/package.json" ]; then
    skip "typecheck" "no package.json"
    return 0
  fi
  if ! grep -q '"typecheck"' "$PROJECT/package.json"; then
    skip "typecheck" "no typecheck script in package.json"
    return 0
  fi
  if run_cmd "cd '$PROJECT' && bun run typecheck" 120; then
    pass "typecheck" "tsc --noEmit clean"
  else
    fail "typecheck" "bun run typecheck failed"
    return 1
  fi
}

# ── Gate 3: Test — bun test ─────────────────────────────────────────────────

gate_test() {
  log "Gate 3: Test (bun test)"
  if ! command -v bun >/dev/null 2>&1; then
    fail "test" "bun not on PATH"
    return 1
  fi
  if run_cmd "cd '$PROJECT' && bun test" 180; then
    pass "test" "bun test suite passed"
  else
    fail "test" "bun test suite failed or timed out"
    return 1
  fi
}

# ── Gate 4: Author — no hardcoded commit-author literals (I-0006) ───────────

gate_author() {
  log "Gate 4: Author lint (I-0006)"
  local script="$PROJECT/bin/lint-no-hardcoded-author.sh"
  if ! [ -x "$script" ]; then
    skip "author" "lint-no-hardcoded-author.sh missing or not executable"
    return 0
  fi
  if run_cmd "'$script'" 30; then
    pass "author" "no hardcoded author literals"
  else
    fail "author" "hardcoded author literal detected — see I-0006"
    return 1
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  log "Starting merge gate project=$PROJECT branch=$BRANCH HEAD=$HEAD_HASH"

  gate_fixture   || true
  gate_typecheck || true
  gate_test      || true
  gate_author    || true

  local failed
  failed=$(printf '%s\n' "${RESULTS[@]}" | grep -c "^FAIL" || true)

  echo ""
  echo "=== SUMMARY ==="
  printf '  %s\n' "${RESULTS[@]}"
  echo "  Overall: $([ "$failed" -eq 0 ] && echo PASS || echo FAIL)"

  [ "$failed" -eq 0 ]
}

main "$@"
