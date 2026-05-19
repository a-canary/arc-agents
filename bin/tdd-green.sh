#!/bin/bash
# tdd-green.sh — per-file test coverage gate.
#
# For each *.ts file added/modified in the diff (excluding *.test.ts, *.d.ts,
# *.config.ts), assert a colocated *.test.ts exists.
#
# Usage:
#   bin/tdd-green.sh [--base <ref>] [--head <ref>] [--project <path>]
# Defaults: base=origin/main, head=HEAD, project=$(git rev-parse --show-toplevel).
#
# Output: per-file JSON lines + SUMMARY block. Exit 0 iff every production
# *.ts in the diff has a colocated *.test.ts.

set -euo pipefail

BASE="origin/main"
HEAD="HEAD"
PROJECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$PROJECT" ]; then
  PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$PROJECT"

RESULTS=()
log() { echo "[tdd-green $(date +%H%M)] $*" >&2; }

# Diff filter:
# - A (added) / M (modified) only — deletes don't need tests.
# - *.ts only (skip .json, .md, .sh, .sql, .svelte etc.)
# - Exclude: *.test.ts, *.d.ts, *.config.ts, scripts in bin/* end in .ts but ok
files=$(git diff --name-only --diff-filter=AM "$BASE...$HEAD" -- '*.ts' \
  | grep -vE '\.(test|d|config)\.ts$' || true)

if [ -z "$files" ]; then
  echo '{"gate":"tdd-green","status":"SKIP","detail":"no production .ts changes"}'
  echo ""
  echo "=== SUMMARY ==="
  echo "  SKIP:tdd-green"
  echo "  Overall: PASS"
  exit 0
fi

while IFS= read -r f; do
  [ -z "$f" ] && continue
  # Skip deleted files (may show in diff but not on disk)
  [ -f "$f" ] || { echo "{\"file\":\"$f\",\"status\":\"SKIP\",\"reason\":\"deleted\"}"; continue; }

  # bin/*.ts can be CLI entrypoints — still require colocated *.test.ts
  test_file="${f%.ts}.test.ts"
  if [ -f "$test_file" ]; then
    echo "{\"file\":\"$f\",\"status\":\"PASS\",\"test\":\"$test_file\"}"
    RESULTS+=("PASS:$f")
  else
    echo "{\"file\":\"$f\",\"status\":\"FAIL\",\"missing\":\"$test_file\"}"
    RESULTS+=("FAIL:$f")
  fi
done <<< "$files"

failed=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL' || true)

echo ""
echo "=== SUMMARY ==="
printf '  %s\n' "${RESULTS[@]}"
echo "  Overall: $([ "$failed" -eq 0 ] && echo PASS || echo FAIL)"

[ "$failed" -eq 0 ]
