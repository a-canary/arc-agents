#!/bin/bash
# arc-tui-loop — director-side render loop for the arc-tui reference module.
# Beats heartbeat every 30s and prints any open prompts addressed to arc-tui.
# Answer with: bun $ARC_AGENTS_ROOT/bin/arc-tui.ts answer <id> <ans>

set -u
TUI="bun $ARC_AGENTS_ROOT/bin/arc-tui.ts"

while :; do
  $TUI heartbeat >/dev/null 2>&1 || echo "[arc-tui-loop] heartbeat failed" >&2
  out=$($TUI list 2>/dev/null)
  if [ -n "$out" ]; then
    echo "--- $(date -Iseconds) open prompts ---"
    echo "$out"
  fi
  sleep 30
done
