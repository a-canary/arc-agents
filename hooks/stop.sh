#!/bin/bash
# arc-agents Stop hook — AFK shutdown reminder for ephemeral workers.
#
# Fires when claude wants to end the turn. For a worker (ARC_TASK_ID set),
# we check the ledger: if the task is still in a non-terminal state, we
# block the stop ONCE with a reminder of the AFK shutdown checklist. The
# worker can then either drive the task to merged/failed via bookie, or
# decompose into HITL children. After one nudge per turn we let it pass —
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

# Stop hooks can fire repeatedly (block → agent runs → tries to stop again).
# Use stop_hook_active in the input payload to avoid an infinite loop.
INPUT="$(cat || true)"
ACTIVE="$(echo "$INPUT" | grep -oE '"stop_hook_active"[[:space:]]*:[[:space:]]*true' || true)"
if [ -n "$ACTIVE" ]; then
  exit 0
fi

# Read current state. Reads are direct — bookie is for writes only.
SHOW_JSON="$(bun "$LEDGER_BIN" show "$ARC_TASK_ID" 2>/dev/null || true)"
STATE="$(echo "$SHOW_JSON" | grep -oE '"state"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"

case "$STATE" in
  merged|failed|cancelled|blocked)
    # Terminal or properly-blocked. Worker did the right thing. Allow.
    exit 0
    ;;
  "")
    # Couldn't read — don't block on infra glitch.
    exit 0
    ;;
esac

# Non-terminal state: nudge the agent through the checklist. Use printf (not
# heredoc) so the embedded \n escapes reach the JSON string verbatim — heredoc
# interpretation would inject literal newlines and break parse.
printf '%s\n' "{
  \"decision\": \"block\",
  \"reason\": \"AFK shutdown checklist — task $ARC_TASK_ID is still in state '$STATE'.\\n\\nBefore exiting, route ONE of these through the bookie subagent:\\n  - Done?  -> update --state merged --evidence \\\"<one-line>\\\" --pr <url-or-branch>\\n  - Unrecoverable? -> update --state failed --evidence \\\"<one-line>\\\"\\n  - Needs a human? -> decompose <task> --child \\\"<HITL step>\\\" [--child ...]  (cap 5)\\n\\nHYGIENE PHASE (not enforced): observations made during this slice that are out of scope should become ready rows, not bundled cleanup. Through the bookie subagent, emit 0..N hygiene followups using:\\n  bin/ledger.ts hygiene-emit --skill <s> --title \\\"<observation>\\\" [--body \\\"<details>\\\"] [--observed-in-task <ARC_TASK_ID>]\\n  skills: clarify-docs, improve-architecture, trash-retired-files, analyse-recent-sessions\\n  dedup is automatic against existing ready/blocked/wip/claimed hygiene rows with similar titles.\\n\\nOther suggestions (not enforced): check that docs in scope are still accurate; commit as the configured git user; remove your worktree with 'git worktree remove'.\\n\\nOnce the ledger is in a terminal or blocked state, this hook will pass through automatically.\"
}"
exit 0
