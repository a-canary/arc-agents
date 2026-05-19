#!/bin/bash
# slice-guard.sh — PR-scope G-0005 enforcement.
#
# Enforces "one thin vertical slice per PR" by inspecting the cumulative diff
# of the current branch against its merge base with origin/main (or BASE_REF):
#   - modified-line cap: total added+deleted across non-vendored files <= MAX_LINES (default 2000)
#   - top-level area cap: changes touch at most MAX_AREAS top-level directories (default 1)
#
# Complements per-commit hooks: those gate individual commits; this catches
# accumulation across a PR and bypasses (SLICE_GUARD_SKIP=1) at the commit hook.
#
# Usage: bin/slice-guard.sh [--base <ref>] [--max-lines N] [--max-areas N] [--project <path>]
# Env:   BASE_REF, MAX_LINES, MAX_AREAS, PROJECT, SLICE_GUARD_SKIP=1 (bypass)
# Exit:  0 PASS/SKIP, 1 FAIL. Emits one JSON line + human summary on stderr.

set -euo pipefail

if [ "${SLICE_GUARD_SKIP:-0}" = "1" ]; then
  echo '{"gate":"slice-guard","status":"SKIP","detail":"SLICE_GUARD_SKIP=1"}'
  exit 0
fi

BASE_REF="${BASE_REF:-origin/main}"
MAX_LINES="${MAX_LINES:-2000}"
MAX_AREAS="${MAX_AREAS:-1}"
PROJECT="${PROJECT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --base)      BASE_REF="$2"; shift 2 ;;
    --max-lines) MAX_LINES="$2"; shift 2 ;;
    --max-areas) MAX_AREAS="$2"; shift 2 ;;
    --project)   PROJECT="$2"; shift 2 ;;
    *)           shift ;;
  esac
done

if [ -z "$PROJECT" ]; then
  PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$PROJECT"

# Resolve base; fall back to local main if origin/main missing.
if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  if git rev-parse --verify main >/dev/null 2>&1; then
    BASE_REF="main"
  else
    echo "{\"gate\":\"slice-guard\",\"status\":\"SKIP\",\"detail\":\"no base ref ($BASE_REF or main)\"}"
    exit 0
  fi
fi

MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "")"
if [ -z "$MERGE_BASE" ]; then
  echo "{\"gate\":\"slice-guard\",\"status\":\"SKIP\",\"detail\":\"no merge-base with $BASE_REF\"}"
  exit 0
fi

# Numstat: <added> <deleted> <path>; exclude vendored/generated paths.
# Binary files report "-\t-\t<path>" — skip those for line counting.
NUMSTAT="$(git diff --numstat "$MERGE_BASE"...HEAD -- \
  ':(exclude)node_modules' \
  ':(exclude)*.lock' \
  ':(exclude)bun.lockb' \
  ':(exclude)package-lock.json' \
  ':(exclude)dist' \
  ':(exclude)build' \
  ':(exclude).next' \
  ':(exclude)*.min.js' \
  ':(exclude)*.min.css' \
  2>/dev/null || true)"

if [ -z "$NUMSTAT" ]; then
  echo '{"gate":"slice-guard","status":"PASS","detail":"no changes vs base"}'
  exit 0
fi

TOTAL_LINES=0
declare -A AREAS=()
while IFS=$'\t' read -r added deleted path; do
  [ -z "${path:-}" ] && continue
  if [ "$added" = "-" ] || [ "$deleted" = "-" ]; then
    # binary file — count as 1 modified line so it registers as activity
    TOTAL_LINES=$((TOTAL_LINES + 1))
  else
    TOTAL_LINES=$((TOTAL_LINES + added + deleted))
  fi
  area="${path%%/*}"
  # files at repo root (no slash) → area = "<root>"
  if [ "$area" = "$path" ]; then
    area="<root>"
  fi
  AREAS["$area"]=1
done <<< "$NUMSTAT"

AREA_LIST="$(printf '%s\n' "${!AREAS[@]}" | sort | paste -sd, -)"
AREA_COUNT="${#AREAS[@]}"

LINE_FAIL=0
AREA_FAIL=0
[ "$TOTAL_LINES" -gt "$MAX_LINES" ] && LINE_FAIL=1
[ "$AREA_COUNT" -gt "$MAX_AREAS" ] && AREA_FAIL=1

DETAIL="lines=$TOTAL_LINES/$MAX_LINES areas=$AREA_COUNT/$MAX_AREAS [$AREA_LIST] base=$BASE_REF"

if [ "$LINE_FAIL" -eq 1 ] || [ "$AREA_FAIL" -eq 1 ]; then
  echo "{\"gate\":\"slice-guard\",\"status\":\"FAIL\",\"detail\":\"$DETAIL\"}"
  {
    echo "slice-guard FAIL: $DETAIL"
    [ "$LINE_FAIL" -eq 1 ] && echo "  modified-line cap exceeded ($TOTAL_LINES > $MAX_LINES)"
    [ "$AREA_FAIL" -eq 1 ] && echo "  top-level area cap exceeded ($AREA_COUNT > $MAX_AREAS): $AREA_LIST"
    echo "  bypass: SLICE_GUARD_SKIP=1 (use only with explicit justification)"
  } >&2
  exit 1
fi

echo "{\"gate\":\"slice-guard\",\"status\":\"PASS\",\"detail\":\"$DETAIL\"}"
exit 0
