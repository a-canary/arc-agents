#!/bin/bash
# arc-agents PreToolUse hook — block destructive ops; route rm to to-trash.
# Worker context: ledger-dispatched, work happens in ~/worktrees/<repo>-<slug>/.

TOOL="$1"
PAYLOAD="$2"

if [ "$TOOL" = "Bash" ]; then
  if echo "$PAYLOAD" | grep -qE 'rm\s+-(rf|fr|f)'; then
    echo "HOOK_BLOCKED: rm -rf is blocked. Use ~/agents/bin/to-trash.ts <path> --reason <why>."
    exit 1
  fi
  if echo "$PAYLOAD" | grep -Eiq "git\s+push\s+--force|git\s+reset\s+--hard"; then
    echo "HOOK_BLOCKED: destructive git pattern. Confirm intent before retry."
    exit 1
  fi
fi

exit 0
