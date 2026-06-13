#!/bin/bash
# pre-merge.sh — composite pre-merge gate for arc-agents PRs.
#
# Runs every local gate in order. Used by the merger subagent before
# `gh pr merge`. Each gate is non-fatal individually — we collect all
# results then exit 0 iff zero FAILs.
#
# Gates (in order):
#   1. branch-clean   — no uncommitted changes, working tree clean
#   2. rebased        — head is rebased on $BASE (no merge commits in branch)
#   3. author-lint    — every commit author matches I-0006 (a-canary)
#   4. slice-guard   — PR diff ≤2000 modified-line equivs + ≤1 top-level area (G-0005)
#   5. api-key-guard — no hardcoded API keys / empty env var fallbacks in staged diff
#   6. tdd-green      — colocated *.test.ts for every prod .ts in diff
#   7. todo-sweep     — TODO/FIXME/XXX reference a ledger task or PR
#   8. merge-gate     — fixture + typecheck + bun test (bin/merge-gate.sh)
#   9. ci-green       — gh pr checks <num> all PASS (if --pr passed)
#
# Usage:
#   bin/pre-merge.sh [--base <ref>] [--pr <num>] [--project <path>]
#
# Defaults: base=origin/main, project=$(git rev-parse --show-toplevel).
# If --pr is given, ci-green runs; otherwise it's SKIPped.

set -euo pipefail

BASE="origin/main"
PR_NUM=""
PROJECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --pr) PR_NUM="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# BIN is always resolved from this script's own location — gate scripts may
# not exist in the target $PROJECT (e.g. older branch, different repo). Allow
# overriding via --bin if the merger user wants to test a different gate set.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$PROJECT" ]; then
  PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
cd "$PROJECT"

BIN="$SCRIPT_DIR"
RESULTS=()

pass() { echo "{\"gate\":\"$1\",\"status\":\"PASS\",\"detail\":\"$2\"}"; RESULTS+=("PASS:$1"); }
fail() { echo "{\"gate\":\"$1\",\"status\":\"FAIL\",\"detail\":\"$2\"}"; RESULTS+=("FAIL:$1"); }
skip() { echo "{\"gate\":\"$1\",\"status\":\"SKIP\",\"detail\":\"$2\"}"; RESULTS+=("SKIP:$1"); }
log() { echo "[pre-merge $(date +%H%M)] $*" >&2; }

# Gate 1: branch-clean
gate_branch_clean() {
  log "Gate 1: branch-clean"
  if [ -n "$(git status --porcelain)" ]; then
    fail "branch-clean" "uncommitted changes in working tree"
    return
  fi
  pass "branch-clean" "working tree clean"
}

# Gate 2: rebased
gate_rebased() {
  log "Gate 2: rebased on $BASE"
  # Fetch the base ref (best-effort; offline = skip)
  git fetch origin --quiet 2>/dev/null || true

  if ! git rev-parse "$BASE" >/dev/null 2>&1; then
    skip "rebased" "base ref $BASE not available"
    return
  fi

  # No merge commits in branch range
  local merges
  merges=$(git log --merges "$BASE..HEAD" --oneline | wc -l)
  if [ "$merges" -gt 0 ]; then
    fail "rebased" "$merges merge commit(s) in branch — rebase needed"
    return
  fi

  # Head must contain base
  if ! git merge-base --is-ancestor "$BASE" HEAD; then
    fail "rebased" "HEAD is not based on $BASE"
    return
  fi
  pass "rebased" "rebased on $BASE, no merge commits"
}

# Gate 3: author-lint (I-0006 — commits authored by configured git user)
gate_author_lint() {
  log "Gate 3: author-lint"
  local expected_name expected_email
  expected_name="$(git config user.name 2>/dev/null || echo '')"
  expected_email="$(git config user.email 2>/dev/null || echo '')"

  if [ -z "$expected_name" ] || [ -z "$expected_email" ]; then
    skip "author-lint" "git user.name/user.email not configured"
    return
  fi

  local bad
  bad=$(git log "$BASE..HEAD" --format='%an <%ae>' \
    | grep -v "^$expected_name <$expected_email>$" || true)
  if [ -n "$bad" ]; then
    fail "author-lint" "non-canonical authors: $(echo "$bad" | head -3 | tr '\n' ';')"
    return
  fi
  pass "author-lint" "all commits authored by $expected_name"
}

# Gate 4: slice-guard — PR-scope G-0005 enforcement (2000-line cap + 1-area cap)
gate_slice_guard() {
  log "Gate 4: slice-guard"
  if [ ! -x "$BIN/slice-guard.sh" ]; then
    skip "slice-guard" "bin/slice-guard.sh not found"
    return
  fi
  if "$BIN/slice-guard.sh" --base "$BASE" --project "$PROJECT" >/tmp/slice-guard-$$.log 2>&1; then
    pass "slice-guard" "PR diff within G-0005 bounds"
  else
    fail "slice-guard" "PR exceeds G-0005 bounds — see /tmp/slice-guard-$$.log"
  fi
}

# Gate 5: api-key-guard — no hardcoded API keys in staged diff
# Pattern source: conjecture security incident (csk-hpr4... dead key in git history).
# Matches bare key strings, empty env var fallbacks, and plain-text config values.
gate_api_key_guard() {
  log "Gate 5: api-key-guard"
  # Extract added lines from staged diff (skip diff headers)
  local staged_diff
  staged_diff=$(git diff --cached -U0 \
    -- '*.ts' '*.js' '*.py' '*.sh' '*.yaml' '*.yml' '*.json' '*.svelte' '*.md' \
    | grep -E '^\+[^+]' \
    | grep -v '^(\+\+|---|\s*Index:)' \
    || true)

  if [ -z "$staged_diff" ]; then
    skip "api-key-guard" "no staged additions"
    return
  fi

  # Grep patterns: bare secret strings, empty env var defaults, plain-text key fields.
  # Each got its own line in the while loop so violations are isolated.
  local found=0
  # shellcheck disable=SC2016  # backtick expansion inside '' intentionally literal
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Cerebras, OpenAI, Anthropic, Azure key prefixes (any 20+ char token-like string)
    if echo "$line" | grep -qE "'csk-[A-Za-z0-9]{20,}'" || \
       echo "$line" | grep -qE '"csk-[A-Za-z0-9]{20,}"' || \
       echo "$line" | grep -qE "'sk-[A-Za-z0-9]{20,}'" || \
       echo "$line" | grep -qE '"sk-[A-Za-z0-9]{20,}"'; then
      fail "api-key-guard" "bare API key string found: ${line:0:80}"
      found=1
      break
    fi
    # os.environ.get / os.getenv with empty-fallback default (silent fail on unset)
    if echo "$line" | grep -qE $'os\\.getenv\\([^)]*["\'"]' || \
       echo "$line" | grep -qE $'os\\.environ\\.get\\([^)]*["\'"]'; then
      fail "api-key-guard" "empty env-var default (silent fail): ${line:0:80}"
      found=1
      break
    fi
    # "key": "20+charvalue" plain-text in JSON/YAML config
    if echo "$line" | grep -qE '"[a-z_-]{0,20}key[a-z_-]{0,20}"\s*:\s*"[A-Za-z0-9]{16,}"'; then
      fail "api-key-guard" "plain-text API key in config: ${line:0:80}"
      found=1
      break
    fi
    # API_KEY = "" / = '' (empty string assignment)
    if echo "$line" | grep -qE $'(API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|CEREBRAS_API_KEY)\s*=\s*["\']{2}'; then
      fail "api-key-guard" "empty API_KEY assignment found: ${line:0:80}"
      found=1
      break
    fi
  done <<< "$staged_diff"

  if [ "$found" -eq 0 ]; then
    pass "api-key-guard" "no hardcoded API key patterns in staged diff"
  fi
}

# Gate 6: tdd-green
gate_tdd_green() {
  log "Gate 5: tdd-green"
  if [ ! -x "$BIN/tdd-green.sh" ]; then
    skip "tdd-green" "bin/tdd-green.sh not found"
    return
  fi
  if "$BIN/tdd-green.sh" --base "$BASE" --project "$PROJECT" >/tmp/tdd-green-$$.log 2>&1; then
    pass "tdd-green" "all prod .ts files have colocated tests"
  else
    fail "tdd-green" "missing tests — see /tmp/tdd-green-$$.log"
  fi
}

# Gate 7: todo-sweep
gate_todo_sweep() {
  log "Gate 6: todo-sweep"
  if [ ! -x "$BIN/todo-sweep.sh" ]; then
    skip "todo-sweep" "bin/todo-sweep.sh not found"
    return
  fi
  if "$BIN/todo-sweep.sh" --base "$BASE" --project "$PROJECT" >/tmp/todo-sweep-$$.log 2>&1; then
    pass "todo-sweep" "all TODOs reference a ledger task"
  else
    fail "todo-sweep" "bare TODOs found — see /tmp/todo-sweep-$$.log"
  fi
}

# Gate 8: merge-gate (fixture + typecheck + bun test)
gate_merge_gate() {
  log "Gate 8: merge-gate (fixture+typecheck+test)"
  if [ ! -x "$BIN/merge-gate.sh" ]; then
    fail "merge-gate" "bin/merge-gate.sh not found"
    return
  fi
  local log=/tmp/merge-gate-$$.log
  if "$BIN/merge-gate.sh" --project "$PROJECT" >"$log" 2>&1; then
    pass "merge-gate" "fixture+typecheck+test passed"
  else
    if grep -q "tsc: command not found\|tsc: not found" "$log"; then
      fail "merge-gate" "see $log — try 'bun install' first?"
    else
      fail "merge-gate" "see $log"
    fi
  fi
}

# Gate 9: ci-green (gh pr checks)
gate_ci_green() {
  log "Gate 9: ci-green"
  if [ -z "$PR_NUM" ]; then
    skip "ci-green" "no --pr given"
    return
  fi
  if ! command -v gh >/dev/null 2>&1; then
    skip "ci-green" "gh CLI not installed"
    return
  fi
  # gh pr checks exits non-zero if any check failed/pending
  if gh pr checks "$PR_NUM" >/tmp/ci-green-$$.log 2>&1; then
    pass "ci-green" "all PR checks green"
  else
    if grep -qi 'no checks reported' /tmp/ci-green-$$.log 2>/dev/null; then
      skip "ci-green" "no checks reported on PR"
    elif grep -qE 'pending|in_progress' /tmp/ci-green-$$.log 2>/dev/null; then
      fail "ci-green" "PR checks still pending"
    else
      fail "ci-green" "one or more PR checks failed — see /tmp/ci-green-$$.log"
    fi
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────
log "Starting pre-merge gate project=$PROJECT base=$BASE pr=${PR_NUM:-<none>}"

gate_branch_clean
gate_rebased
gate_author_lint
gate_slice_guard
gate_api_key_guard
gate_tdd_green
gate_todo_sweep
gate_merge_gate
gate_ci_green

failed=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL' || true)

echo ""
echo "=== SUMMARY ==="
printf '  %s\n' "${RESULTS[@]}"
echo "  Overall: $([ "$failed" -eq 0 ] && echo PASS || echo FAIL)"

[ "$failed" -eq 0 ]
