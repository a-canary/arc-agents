#!/usr/bin/env bash
# G-0005 PR-scope slice guard: fail if PR diff exceeds ~2000 modified-line
# equivalents or spans more than one top-level area.
#
# Top-level area = first path segment (e.g. "bin", "src", "skills", "hooks",
# "docs", "profiles"). Top-level files (CLAUDE.md, CONTEXT.md, etc.) count as
# area "_root".
#
# Mirrors hooks/pre-commit-slice-guard.sh but operates on the full PR diff
# (git diff origin/main...HEAD) rather than staged changes. Catches commits
# that individually pass the per-commit hook (or bypass with
# SLICE_GUARD_SKIP=1) but accumulate into an oversized PR.
#
# Bypass: SLICE_GUARD_SKIP=1 bin/slice-guard.sh
#
# Usage: bin/slice-guard.sh [--base <ref>] [--project <path>]
#   Defaults: base=origin/main, project=$(git rev-parse --show-toplevel).

set -euo pipefail

BASE="${SLICE_GUARD_BASE:-origin/main}"
PROJECT="${SLICE_GUARD_PROJECT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$PROJECT" ]; then
  PROJECT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
cd "$PROJECT"

if [[ "${SLICE_GUARD_SKIP:-0}" == "1" ]]; then
  exit 0
fi

MAX_LINES="${SLICE_GUARD_MAX_LINES:-2000}"
MAX_AREAS="${SLICE_GUARD_MAX_AREAS:-1}"

# PR diff: all changes since $BASE (including history since last rebase)
diff_output=$(git diff "$BASE...HEAD" --numstat --no-renames 2>/dev/null || true)

if [[ -z "$diff_output" ]]; then
  # No diff (empty PR or base not reachable) — pass
  exit 0
fi

total=0
declare -A areas=()
while IFS=$'\t' read -r added deleted path; do
  [[ -z "${path:-}" ]] && continue
  # binary files show "-" "-"; skip line counting
  if [[ "$added" != "-" ]]; then
    total=$(( total + added + deleted ))
  fi
  area="${path%%/*}"
  if [[ "$area" == "$path" ]]; then
    area="_root"
  fi
  areas["$area"]=1
done <<< "$diff_output"

area_count=${#areas[@]}
area_list=$(printf '%s ' "${!areas[@]}")

fail=0
msgs=()
if (( total > MAX_LINES )); then
  msgs+=("slice-guard: $total modified-line equivalents > cap $MAX_LINES")
  fail=1
fi
if (( area_count > MAX_AREAS )); then
  msgs+=("slice-guard: $area_count top-level areas touched ($area_list) > cap $MAX_AREAS")
  fail=1
fi

if (( fail )); then
  printf '%s\n' "${msgs[@]}" >&2
  echo "  bypass with SLICE_GUARD_SKIP=1 bin/slice-guard.sh" >&2
  exit 1
fi

exit 0
