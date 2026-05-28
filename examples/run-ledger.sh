#!/bin/bash
# Minimal ledger demo — runnable from a clean clone.
# Requires: bun (bun.sh)
#
# This script demonstrates the core loop of arc-agents:
#   init → create → list → claim → update → event → tick
#
# All paths are relative to the repo root.  The ledger DB lives at
# $ARC_LEDGER_DB (default: /tmp/arc-demo.sqlite) so this is safe to run
# without touching any personal vault.
#
# Usage:
#   examples/run-ledger.sh              # interactive (TTY)
#   examples/run-ledger.sh --dry-run    # print commands, don't execute

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Config — public / self-contained
# ---------------------------------------------------------------------------
LEDGER_DB="${ARC_LEDGER_DB:-/tmp/arc-demo.sqlite}"
LEDGER="${REPO_ROOT}/bin/ledger.ts"
WORKER="demo-worker-$$"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

run() {
  if (( DRY_RUN )); then
    echo "# [dry-run] $*"
  else
    echo "$ $@" >&2
    "$@"
  fi
}

announce() {
  echo ""
  echo "=== $1 ==="
  echo ""
}

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
announce "1. Init ledger (creates tables + runs migrations)"
run bun "$LEDGER" init --db "$LEDGER_DB"

# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------
announce "2. Create a demo task"
TASK_JSON=$(run bun "$LEDGER" create \
  --kind task \
  --type quality \
  --title "Demo: public arc-agents example" \
  --body "Runnable demo task showing arc-agents ledger usage." \
  --acceptance "Ledger init, create, list, claim, update, event, tick all succeed." \
  --project arc-agents \
  --agent cli \
  --db "$LEDGER_DB")

# Extract the id from JSON output (pure bash, no jq required)
TASK_ID=$(echo "$TASK_JSON" | sed -n 's/.*"id": "\([^"]*\)".*/\1/p')
echo "Created task: $TASK_ID"

# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------
announce "3. List open tasks"
run bun "$LEDGER" list --db "$LEDGER_DB"

# ---------------------------------------------------------------------------
# Claim
# ---------------------------------------------------------------------------
announce "4. Claim the task (simulated — use your own worker name)"
CLAIM_JSON=$(run bun "$LEDGER" claim "$WORKER" --db "$LEDGER_DB")
echo "$CLAIM_JSON"

# ---------------------------------------------------------------------------
# Update + Event
# ---------------------------------------------------------------------------
announce "5. Advance to wip + add progress event"
run bun "$LEDGER" update "$TASK_ID" --state wip --db "$LEDGER_DB"
run bun "$LEDGER" event "$TASK_ID" progress "demo progress note" --agent cli --db "$LEDGER_DB"

# ---------------------------------------------------------------------------
# Tick
# ---------------------------------------------------------------------------
announce "6. Tick (cascade-unblock + reclaim stale)"
run bun "$LEDGER" tick --db "$LEDGER_DB"

# ---------------------------------------------------------------------------
# Show
# ---------------------------------------------------------------------------
announce "7. Show full issue + events"
run bun "$LEDGER" show "$TASK_ID" --db "$LEDGER_DB"

# ---------------------------------------------------------------------------
# Clean up
# ---------------------------------------------------------------------------
announce "Done. Ledger DB at: $LEDGER_DB"
echo "To inspect manually:  sqlite3 $LEDGER_DB '.tables'  sqlite3 $LEDGER_DB 'SELECT * FROM issues;'"
echo "To reset:             rm $LEDGER_DB"