#!/bin/bash
# todo-sweep.sh — TODO/FIXME/XXX must reference a ledger task.
#
# Each TODO/FIXME/XXX comment added in the PR diff must include a ledger
# issue id (matching ARC-[0-9]+ or arc-[0-9a-f]{8,} uuid prefix). Bare
# TODOs without a pointer fail the gate — pushes the worker to file a
# follow-up task instead of leaving floating reminders.
#
# Usage: bin/todo-sweep.sh [--base <ref>] [--head <ref>] [--project <path>]
# Default: base=origin/main, head=HEAD, project=$(git rev-parse --show-toplevel).
# Output: per-finding JSON lines + SUMMARY. Exit 0 iff every TODO references a task.

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
log() { echo "[todo-sweep $(date +%H%M)] $*" >&2; }

# Added lines only (start with '+', not '+++').
# Match TODO/FIXME/XXX anywhere on the line.
added=$(git diff "$BASE...$HEAD" -U0 -- '*.ts' '*.sh' '*.svelte' '*.md' \
  | grep -E '^\+[^+]' \
  | grep -iE '(TODO|FIXME|XXX)' || true)

if [ -z "$added" ]; then
  echo '{"gate":"todo-sweep","status":"SKIP","detail":"no TODO/FIXME/XXX added"}'
  echo ""
  echo "=== SUMMARY ==="
  echo "  SKIP:todo-sweep"
  echo "  Overall: PASS"
  exit 0
fi

# Each TODO must mention a ledger id: ARC-<n>, arc-<uuid8+>, or #<n> (GitHub).
# Bare TODO fails.
ok_pattern='(ARC-[0-9]+|arc-[0-9a-f]{8}|#[0-9]+)'

while IFS= read -r line; do
  [ -z "$line" ] && continue
  trimmed=$(echo "$line" | sed 's/^+//')
  if echo "$trimmed" | grep -qE "$ok_pattern"; then
    echo "{\"line\":$(echo "$trimmed" | jq -Rs .),\"status\":\"PASS\"}"
    RESULTS+=("PASS")
  else
    echo "{\"line\":$(echo "$trimmed" | jq -Rs .),\"status\":\"FAIL\",\"reason\":\"bare TODO — needs ARC-<n>, arc-<uuid8>, or #<pr>\"}"
    RESULTS+=("FAIL")
  fi
done <<< "$added"

failed=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL' || true)

echo ""
echo "=== SUMMARY ==="
printf '  %s\n' "${RESULTS[@]}"
echo "  Overall: $([ "$failed" -eq 0 ] && echo PASS || echo FAIL)"

[ "$failed" -eq 0 ]
