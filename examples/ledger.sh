#!/usr/bin/env bash
# ledger.sh — arc-agents ledger CLI demo using a temp DB.
#
# Demonstrates: init, create, list, show, update, event
# Uses a throwaway DB — safe to run.
#
# Prerequisites:
#   bun install   # in the arc-agents repo root

set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$WORKSPACE/bin/ledger.ts"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

TEMP_DB="/tmp/arc-examples-ledger-$$-$(date +%s).db"

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $1"; }
err()   { echo -e "${RED}[ERR ]${NC} $1"; }

cleanup() {
  if [[ -f "$TEMP_DB" ]]; then
    rm -f "$TEMP_DB"
    info "Removed temp DB"
  fi
}
trap cleanup EXIT

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  arc-agents — Ledger CLI Demo"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Init ───────────────────────────────────────────────────────────────────
info "Step 1: Initialize fresh ledger"
OUT=$("$LEDGER" init --db "$TEMP_DB" 2>&1)
echo "$OUT"
if echo "$OUT" | grep -q '"applied"'; then
  ok "ledger init OK"
else
  err "ledger init failed"
  exit 1
fi
echo ""

# ── 2. Create ─────────────────────────────────────────────────────────────────
info "Step 2: Create a sample issue"
OUT=$("$LEDGER" create \
  --db "$TEMP_DB" \
  --title "demo: hello world" \
  --kind task \
  --type quality \
  --pool explore 2>&1)
echo "$OUT"
if echo "$OUT" | grep -q '"id"'; then
  ok "issue created"
  ISSUE_ID=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
  if [[ -z "$ISSUE_ID" ]]; then
    err "failed to parse issue id"
    exit 1
  fi
  echo "  → issue id: $ISSUE_ID"
else
  err "create failed"
  exit 1
fi
echo ""

# ── 3. List ────────────────────────────────────────────────────────────────────
info "Step 3: List all issues"
OUT=$("$LEDGER" list --db "$TEMP_DB" 2>&1 | head -5)
echo "$OUT"
ok "ledger list works"
echo ""

# ── 4. Show ─────────────────────────────────────────────────────────────────────
info "Step 4: Show the created issue"
OUT=$("$LEDGER" show "$ISSUE_ID" --db "$TEMP_DB" 2>&1 | head -20)
echo "$OUT"
ok "ledger show works"
echo ""

# ── 5. Event ──────────────────────────────────────────────────────────────────
info "Step 5: Append a note event"
OUT=$("$LEDGER" event "$ISSUE_ID" note "Demo: first interaction" --db "$TEMP_DB" 2>&1)
echo "$OUT"
# grep for 'logged' but don't fail script if not found (set -e safety)
if grep -q '"logged"' <<< "$OUT"; then
  ok "event appended"
else
  info "event command output shown above"
fi
echo ""

# ── 6. Summary ─────────────────────────────────────────────────────────────────
info "Demo complete. The temp DB has been cleaned up."
echo ""
echo "What you just did:"
echo "  init     — create + migrate a fresh SQLite ledger"
echo "  create   — insert a row; ledger assigns the id"
echo "  list     — query all issues (returns JSON by default)"
echo "  show     — full issue row + event history"
echo "  event    — append an append-only issue_events row"
echo ""
echo "Next steps:"
echo "  bun $LEDGER tick              # claim + dispatch workers"
echo "  bun $LEDGER spawn-ready       # spawn workers for ready issues"