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

# --- Worker lease heartbeat ---------------------------------------------
# Cooperative anti-reaper lease: write a heartbeat so the worktree-reaper
# knows to skip this worktree for 10 min (exceeds the 5-min factory tick).
# Guard: only write if this looks like a worker session (ARC_TASK_ID set,
# i.e. the worktree path is the CWD).
if [ -n "${ARC_TASK_ID:-}" ]; then
  LEASE="$(pwd)/.worker-lease"
  date +%s > "$LEASE" 2>/dev/null || true
fi

# --- AGENTS-GLOBAL.md collector ----------------------------------------------
# Convention: AGENTS-GLOBAL.md = rules that must ESCAPE their repo to reach a
# cross-repo orchestrator (e.g. a Director dispatching workers into siblings it
# never cd's into). Repo-LOCAL rules go in AGENTS.md, which the harness already
# scopes by cwd — those must NOT live here. User-global rules live in ~/AGENTS.md
# (system prompt). The filename is the access modifier: naming a file
# AGENTS-GLOBAL.md is the deliberate act of promotion.
#
# Sources: every ~/repos/*/AGENTS-GLOBAL.md plus the current repo root.
# cwd-agnostic by design; deduped by realpath.
collect_agents_global() {
  local -a candidates=()
  for d in "$HOME"/repos/*; do
    [ -d "$d" ] && candidates+=( "$d/AGENTS-GLOBAL.md" )
  done
  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$repo_root" ] && candidates+=( "$repo_root/AGENTS-GLOBAL.md" )

  local -A seen=()
  local printed=0 f real
  for f in "${candidates[@]}"; do
    [ -f "$f" ] || continue
    real="$(realpath "$f")"
    [ -n "${seen[$real]:-}" ] && continue
    seen[$real]=1
    if [ "$printed" -eq 0 ]; then
      echo ""
      echo "=== AGENTS-GLOBAL directives (apply to this session) ==="
      printed=1
    fi
    echo "--- $real ---"
    cat "$f"
  done
}
collect_agents_global

exit 0
