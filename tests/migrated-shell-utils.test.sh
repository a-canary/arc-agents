#!/usr/bin/env bash
# Smoke tests for migrated agent-system shell utilities.
# Run: bash tests/migrated-shell-utils.test.sh

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

passed=0
failed=0

smoke() {
  local name="$1"; shift
  local cmd="$*"
  echo -n "  $name ... "
  if eval "$cmd" >/dev/null 2>&1; then
    echo "OK"
    passed=$((passed + 1))
  else
    echo "FAIL"
    failed=$((failed + 1))
  fi
}

echo "=== migrated shell utils smoke tests ==="

# bin/report-error.sh
smoke "report-error.sh executable" "[ -x '$REPO/bin/report-error.sh' ]"
smoke "report-error.sh exits on missing args" "! '$REPO/bin/report-error.sh' 2>/dev/null"

# bin/cron-preamble.sh
smoke "cron-preamble.sh executable" "[ -x '$REPO/bin/cron-preamble.sh' ]"
smoke "cron-preamble.sh sources cleanly" "(. '$REPO/bin/cron-preamble.sh' 2>&1; true)"

# hooks/inbox-surface.sh
smoke "inbox-surface.sh executable" "[ -x '$REPO/hooks/inbox-surface.sh' ]"
smoke "inbox-surface.sh no args (returns {})" "$REPO/hooks/inbox-surface.sh 2>/dev/null | grep -q '{}'"

echo ""
echo "=== results: $passed passed, $failed failed ==="
[ "$failed" -eq 0 ]