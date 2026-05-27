#!/bin/bash
# arc-agents Stop hook -- AFK shutdown reminder for ephemeral workers.
#
# Fires when claude wants to end the turn. For a worker (ARC_TASK_ID set),
# we check the ledger: if the task is still in a non-terminal state, we
# block the stop ONCE with a reminder of the AFK shutdown checklist. The
# worker can then either drive the task to merged/failed via bookie, or
# decompose into HITL children. After one nudge per turn we let it pass --
# this is guidance, not enforcement.
#
# Non-worker turns (no ARC_TASK_ID, e.g. interviewer) pass through unchanged.

set -euo pipefail

# No task id = not a worker session. Allow.
if [ -z "${ARC_TASK_ID:-}" ]; then
  exit 0
fi

REPO="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.."
LEDGER_BIN="${REPO}/bin/ledger.ts"

# Stop hooks can fire repeatedly (block -> agent runs -> tries to stop again).
# Use stop_hook_active in the input payload to avoid an infinite loop.
INPUT="$(cat || true)"
ACTIVE="$(echo "$INPUT" | grep -oE '"stop_hook_active"[[:space:]]*:[[:space:]]*true' || true)"
if [ -n "$ACTIVE" ]; then
  exit 0
fi

# Read current state. Reads are direct -- bookie is for writes only.
SHOW_JSON="$(bun "$LEDGER_BIN" show "$ARC_TASK_ID" 2>/dev/null || true)"
STATE="$(echo "$SHOW_JSON" | grep -oE '"state"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"

case "$STATE" in
  merged|failed|cancelled|blocked)
    # Terminal or properly-blocked. Worker did the right thing. Allow.
    exit 0
    ;;
  "")
    # Could not read -- do not block on infra glitch.
    exit 0
    ;;
esac

# Non-terminal state: nudge the agent through the checklist.
# Use printf with explicit \n (actual newlines) -- this produces valid JSON
# since the reason value in JSON uses \n (newline) not \\n (backslash-n).
printf '{"decision": "block", "reason": "AFK shutdown checklist -- task %s is still in state '"'"'%s'"'"'.%s%sBefore exiting, route ONE of these through the bookie subagent:%s  - Done? -> update --state merged --evidence \\"<one-line>\\" --pr <url-or-branch>%s  - Unrecoverable? -> update --state failed --evidence \\"<one-line>\\"%s  - Needs a human? -> decompose <task> --child \\"<HITL step>\\" [--child ...] (cap 5)%s%sAlso suggested (not enforced):%s  - Clean up structural rot -> invoke improve-architecture skill%s  - Retire stale files -> invoke trash-retired-files skill%s  - Mine recent sessions for patterns -> invoke analyse-recent-sessions skill%s  - check that docs in scope are still accurate%s  - commit as the configured git user%s  - remove your worktree with '"'"'git worktree remove'"'"'%s%sTo emit any of the above as a follow-up ledger row without blocking: you can ask the bookie subagent to run:%s  ledger hygiene-emit --skill <s> --title <t> [--body <b>] [--observed-in-task %s]%s%sOnce the ledger is in a terminal or blocked state, this hook will pass through automatically."}\n' \
  "$ARC_TASK_ID" \
  "$STATE" \
  "\n" "\n" \
  "\n" \
  "\n" "\n" \
  "\n" "\n" \
  "\n" "\n" "\n" "\n" "\n" "\n" "\n" \
  "\n" \
  "\n" \
  "$ARC_TASK_ID" \
  "\n" "\n"

exit 0
