#!/usr/bin/env bash
# commands.sh — Show all arc-agents ledger CLI verbs with annotations.
# No services needed; uses --db with a temp path.

set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$WORKSPACE/bin/ledger.ts"
TEMP_DB="/tmp/arc-examples-cmd-overview-$$.db"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }

cleanup() { rm -f "$TEMP_DB"; }
trap cleanup EXIT

# Init once so verbs work
"$LEDGER" init --db "$TEMP_DB" > /dev/null 2>&1

echo "=== arc-agents Ledger CLI Overview ==="
echo ""
echo "All verbs. $TEMP_DB is a throwaway DB."
echo ""

# ── Verbs that work without a specific issue id ──────────────────────────────
info "Verbs that don't need a specific issue:"
echo "  ledger init                        — create + migrate schema"
echo "  ledger create --title X --kind Y  — insert a new issue (flag-only)"
echo "  ledger list                        — show issues (default: ready)"
echo "  ledger list --state wip           — filter by state"
echo "  ledger list --pool explore        — filter by pool"
echo "  ledger list --json                — machine-readable output"
echo "  ledger tick                        — claim ready issues + spawn workers"
echo "  ledger spawn-ready                — spawn workers for all ready issues"
echo "  ledger show <id>                  — full issue + event history (needs id)"
echo "  ledger compact                     — vacuum the DB (no flag needed)"
echo ""

# ── Verbs that need an issue id ───────────────────────────────────────────────
info "Verbs that need an existing issue id:"
echo "  ledger claim <worker> [--pool X]  — atomically assign issue to worker"
echo "  ledger update <id> --state X      — advance state machine"
echo "  ledger update <id> --evidence-md X — set evidence after work"
echo "  ledger update <id> --pr-url X     — set PR link"
echo "  ledger event <id> <kind> <note>   — append append-only event row"
echo ""

# ── State machine ─────────────────────────────────────────────────────────────
info "State machine (G-0001):"
echo "  ready → claimed → wip → review → merged"
echo "    └──────→ blocked (on decomposition)"
echo "    └──────→ failed (on unrecoverable error)"
echo "  merged + cancelled are terminal."
echo ""

# ── Quick demo of list ───────────────────────────────────────────────────────
info "Sample: ledger list --pool explore"
"$LEDGER" list --db "$TEMP_DB" --pool explore 2>&1 | head -5
echo ""

# ── Demo of show ─────────────────────────────────────────────────────────────
# Create a throwaway issue to show
ID=$("$LEDGER" create --db "$TEMP_DB" \
  --title "cmd-overview: sample issue" \
  --kind task --type quality --pool explore 2>&1 | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

if [[ -n "$ID" ]]; then
  info "Sample: ledger show $ID"
  "$LEDGER" show --db "$TEMP_DB" "$ID" 2>&1 | head -10
fi

echo ""
echo "See also:"
echo "  bin/ledger.ts --help       (no --help flag — returns ledger list)"
echo "  skills/bookie/SKILL.md     — bookie's write rules"
echo "  CHOICES.md G-0001/G-0002   — state machine + atomic claim"