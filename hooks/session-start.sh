#!/bin/bash
# Copyright 2026 a-canary
# Licensed under the Apache License, Version 2.0
# SPDX-License-Identifier: Apache-2.0

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

PROFILE="$REPO/profiles/$ROLE.json"
if [ "$ROLE" != "unknown" ] && [ -f "$PROFILE" ] && command -v python3 >/dev/null 2>&1; then
  echo "[arc-agents] profile: $PROFILE"
  python3 - "$PROFILE" "$REPO" <<'PY'
import json, os, sys
profile_path, repo = sys.argv[1], sys.argv[2]
with open(profile_path) as f:
    p = json.load(f)
ctx = p.get("context_files", []) or []
boot = p.get("boot_skills", []) or []
if ctx:
    print(f"[arc-agents] context_files ({len(ctx)}):")
    for rel in ctx:
        full = os.path.join(repo, rel)
        marker = "" if os.path.exists(full) else " (MISSING)"
        print(f"  - {rel}{marker}")
if boot:
    print(f"[arc-agents] boot_skills (invoke via /<name>): {', '.join('/' + s for s in boot)}")
PY
fi

exit 0