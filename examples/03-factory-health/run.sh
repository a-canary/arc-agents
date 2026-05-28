#!/usr/bin/env bash
# examples/03-factory-health/run.sh
# ─────────────────────────────────────────────────────────────────
# Factory health check — runs ledger doctor (pure read, no side effects).
# Use this to verify arc-agents is healthy without spinning up workers.
#
# Prerequisites: bun
#
# Usage:
#   bash examples/03-factory-health/run.sh
#
# No private paths, no proprietary keys. Works from a clean clone.
set -euo pipefail

LEDGER="${LEDGER:-./bin/ledger.ts}"

echo "=== Factory/fledger health check ==="
echo

# ── 1. Doctor (pure read) ───────────────────────────────────────────────────
echo "[1/2] ledger doctor (pure read, no side effects)"
bun "$LEDGER" doctor

# ── 2. State summary ───────────────────────────────────────────────────────
echo
echo "[2/2] state summary"
bun "$LEDGER" list --all --limit 20

echo
echo "=== Done ==="
