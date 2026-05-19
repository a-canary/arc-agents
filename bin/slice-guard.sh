#!/bin/bash
# slice-guard.sh — G-0005 slice-clean check at PR scope.
#
# Mirrors hooks/pre-commit-slice-guard.sh but operates on the full PR diff
# (BASE...HEAD), not just the staged index. Commits can pass the per-commit
# hook (or bypass it with SLICE_GUARD_SKIP=1) and still accumulate into an
# oversized PR — this catches that.
#
# Caps (overridable via env):
#   SLICE_GUARD_MAX_LINES (default 2000) — sum of added+deleted across diff
#   SLICE_GUARD_MAX_AREAS (default 1)    — distinct top-level path segments
#
# Top-level area = first path segment (bin, src, skills, hooks, docs, …).
# Top-level files (CLAUDE.md, package.json, …) count as area "_root".
#
# Usage: bin/slice-guard.sh [--base <ref>] [--project <path>]
# Output: one JSON line + SUMMARY block. Exit 0 iff PR is slice-clean.

set -euo pipefail

BASE="origin/main"
PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$PROJECT" ]; then
  PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$PROJECT"

MAX_LINES="${SLICE_GUARD_MAX_LINES:-2000}"
MAX_AREAS="${SLICE_GUARD_MAX_AREAS:-1}"

if ! git rev-parse "$BASE" >/dev/null 2>&1; then
  echo "{\"gate\":\"slice-guard\",\"status\":\"SKIP\",\"detail\":\"base $BASE unavailable\"}"
  echo ""
  echo "=== SUMMARY ==="
  echo "  SKIP:slice-guard"
  echo "  Overall: PASS"
  exit 0
fi

diff_output=$(git diff --numstat --no-renames "$BASE...HEAD" || true)

if [ -z "$diff_output" ]; then
  echo "{\"gate\":\"slice-guard\",\"status\":\"PASS\",\"detail\":\"empty diff\"}"
  echo ""
  echo "=== SUMMARY ==="
  echo "  PASS:slice-guard"
  echo "  Overall: PASS"
  exit 0
fi

total=0
declare -A areas=()
while IFS=$'\t' read -r added deleted path; do
  [ -z "${path:-}" ] && continue
  if [ "$added" != "-" ]; then
    total=$(( total + added + deleted ))
  fi
  area="${path%%/*}"
  if [ "$area" = "$path" ]; then
    area="_root"
  fi
  areas["$area"]=1
done <<< "$diff_output"

area_count=${#areas[@]}
area_list=$(printf '%s ' "${!areas[@]}" | sed 's/ $//')

msgs=()
if [ "$total" -gt "$MAX_LINES" ]; then
  msgs+=("$total modified-line equivalents > cap $MAX_LINES")
fi
if [ "$area_count" -gt "$MAX_AREAS" ]; then
  msgs+=("$area_count top-level areas touched ($area_list) > cap $MAX_AREAS")
fi

if [ "${#msgs[@]}" -gt 0 ]; then
  detail=$(printf '%s; ' "${msgs[@]}" | sed 's/; $//')
  echo "{\"gate\":\"slice-guard\",\"status\":\"FAIL\",\"detail\":\"$detail\"}"
  echo ""
  echo "=== SUMMARY ==="
  echo "  FAIL:slice-guard"
  echo "  $detail"
  echo "  Overall: FAIL"
  exit 1
fi

echo "{\"gate\":\"slice-guard\",\"status\":\"PASS\",\"detail\":\"$total lines, $area_count area ($area_list)\"}"
echo ""
echo "=== SUMMARY ==="
echo "  PASS:slice-guard"
echo "  Overall: PASS"
exit 0
