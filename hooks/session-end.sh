#!/bin/bash
# arc-agents SessionEnd hook — emit closing event to ledger (best-effort).
# Workers are ledger-dispatched; ledger is the system of record.

ROLE="${ARC_ROLE:-unknown}"
REPO="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.."
LEDGER="$HOME/vault/ledger.db"

echo "[arc-agents] session-end role=$ROLE worktree=$(pwd)"

if [ -f "$LEDGER" ] && command -v bun >/dev/null 2>&1 && [ -n "${ARC_TASK_ID:-}" ]; then
  # event kind 'note' is the catch-all per the issue_events CHECK constraint;
  # marker in payload lets readers filter session-end notes.
  bun "$REPO/bin/ledger.ts" event "$ARC_TASK_ID" note "session-end role=$ROLE task=$ARC_TASK_ID" >/dev/null 2>&1 || true
fi

exit 0
