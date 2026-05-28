#!/bin/bash
# Copyright 2026 a-canary
# Licensed under the Apache License, Version 2.0
# SPDX-License-Identifier: Apache-2.0

# arc-agents SessionEnd hook — emit closing event to ledger (best-effort).
# Workers are ledger-dispatched; ledger is the system of record.

ROLE="${ARC_ROLE:-unknown}"
REPO="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.."
LEDGER="$HOME/vault/ledger.db"

echo "[arc-agents] session-end role=$ROLE worktree=$(pwd)"

if [ -f "$LEDGER" ] && command -v bun >/dev/null 2>&1 && [ -n "${ARC_ISSUE_ID:-}" ]; then
  bun "$REPO/bin/ledger.ts" event "$ARC_ISSUE_ID" session-end "{\"role\":\"$ROLE\"}" >/dev/null 2>&1 || true
fi

exit 0