#!/bin/bash
# arc-agents SessionStart hook — print role context + show ready ledger counts.
# Workers are ledger-dispatched; this is just a quick orientation print.

ROLE="${ARC_ROLE:-unknown}"
LEDGER="$HOME/vault/ledger.db"
REPO="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.."

echo "[arc-agents] role=$ROLE worktree=$(pwd) ledger=$LEDGER"

if [ -f "$LEDGER" ] && command -v bun >/dev/null 2>&1; then
  ready=$(bun "$REPO/bin/ledger.ts" list --kind task --state ready 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
  echo "[arc-agents] ready tasks for $ROLE: $ready"
fi

exit 0
