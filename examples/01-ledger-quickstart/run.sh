#!/usr/bin/env bash
# examples/01-ledger-quickstart/run.sh
# ─────────────────────────────────────────────────────────────────
# Ledger quickstart — create, list, show, tick, doctor.
# Prerequisites: bun (https://bun.sh)
#
# Usage:
#   bash examples/01-ledger-quickstart/run.sh
#
# No private paths, no proprietary keys. Works from a clean clone.
set -euo pipefail

LEDGER="${LEDGER:-./bin/ledger.ts}"

echo "=== Ledger quickstart ==="
echo

# ── 1. Init ────────────────────────────────────────────────────────────────
echo "[1/6] init ledger DB"
bun "$LEDGER" init

# ── 2. Create a task ────────────────────────────────────────────────────────
echo
echo "[2/6] create a quality task"
RESULT=$(bun "$LEDGER" create \
  --kind task \
  --type quality \
  --title "Example: validate ledger works" \
  --body "Confirm arc-agents ledger is operational." \
  --acceptance "bun bin/ledger.ts tick returns JSON" \
  --project "example-project" \
  --agent "cli")
echo "$RESULT"

# parse JSON using bun (consistent with runtime, no external deps)
TMP=$(mktemp)
echo "$RESULT" > "$TMP"
ROW_ID=$(node -e "
  const fs = require('fs');
  const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.id || '');
" "$TMP")
rm -f "$TMP"

if [ -n "$ROW_ID" ]; then
  echo "  created row: $ROW_ID"
else
  echo "  (could not parse row id — skipping show)"
  ROW_ID=""
fi

# ── 3. List ready tasks ─────────────────────────────────────────────────────
echo
echo "[3/6] list ready tasks"
bun "$LEDGER" list --state ready | head -20 || true

# ── 4. Show the row ────────────────────────────────────────────────────────
echo
if [ -n "$ROW_ID" ]; then
  echo "[4/6] show row $ROW_ID"
  bun "$LEDGER" show "$ROW_ID" || true
else
  echo "[4/6] show row (skipped — no row id)"
fi

# ── 5. Tick (cascade unblock + reclaim stale) ──────────────────────────────
echo
echo "[5/6] tick"
bun "$LEDGER" tick

# ── 6. Doctor (health check) ───────────────────────────────────────────────
echo
echo "[6/6] doctor health check"
bun "$LEDGER" doctor

echo
echo "=== Done — ledger is operational ==="
