#!/bin/bash
# arc-agents PreToolUse hook — block destructive ops; route rm to to-trash.
# Worker context: ledger-dispatched, work happens in ~/worktrees/<repo>-<slug>/.

TOOL="$1"
PAYLOAD="$2"

if [ "$TOOL" = "Bash" ]; then
  if echo "$PAYLOAD" | grep -qE 'rm\s+-(rf|fr|f)'; then
    echo "HOOK_BLOCKED: rm -rf is blocked. Use to-trash (arc-skills/skills/trash-retired-files) — trash dir format is ~/trash/\$(date +%s)__<rel-path-with-slashes-as-double-dashes>/ (basename collisions across dirs stay distinct). A bundled 'to-trash' helper is planned but not yet ported into arc-agents (see ADR 0004)."
    exit 1
  fi
  if echo "$PAYLOAD" | grep -Eiq "git\s+push\s+--force|git\s+reset\s+--hard"; then
    echo "HOOK_BLOCKED: destructive git pattern. Confirm intent before retry."
    exit 1
  fi
fi

exit 0
