#!/usr/bin/env bash
# arc-agents ephemeral worker. One claim → one interactive claude → exit.
# Invoked by factory.ts inside a fresh tmux session:
#   tmux new-session -d -s <worker-name> bash worker-shell.sh <worker-name>
# Session dies when claude exits; factory respawns next tick if more work.
#
# Bootstrap exception: this script performs the atomic ledger claim directly
# (bash, pre-agent). All in-session ledger writes route through the bookie
# subagent. Reads stay direct. See .claude/agents/bookie.md.
set -euo pipefail

WORKER="${1:?worker name required}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER_BIN="${REPO}/bin/ledger.ts"
CLAUDE="${CLAUDE_BIN:-claude}"

DB_FLAG=()
[ -n "${ARC_LEDGER_DB:-}" ] && DB_FLAG=(--db "${ARC_LEDGER_DB}")

# Atomic claim. Race-safe — losers get claimed=null and exit.
# ARC_CLAIM_URGENCY (set by factory for fast-pass pool) restricts claim to one bucket.
URGENCY_FLAG=()
[ -n "${ARC_CLAIM_URGENCY:-}" ] && URGENCY_FLAG=(--urgency "${ARC_CLAIM_URGENCY}")
CLAIM_JSON="$(bun "$LEDGER_BIN" claim "$WORKER" "${DB_FLAG[@]}" "${URGENCY_FLAG[@]}")"
CLAIM_ID="$(echo "$CLAIM_JSON" | grep -oE '"claimed":[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' || true)"

if [ -z "$CLAIM_ID" ]; then
  echo "{\"worker\":\"$WORKER\",\"claimed\":null,\"reason\":\"race-lost-or-empty\"}"
  exit 0
fi

# Export for Stop hook + claude to see. Stop hook reads ARC_TASK_ID to check terminal state.
export ARC_WORKER_SESSION="$WORKER"
export ARC_TASK_ID="$CLAIM_ID"

# Per-(kind,type) system prompt resolved in TS — see src/worker/templates.ts.
SYS_PROMPT="$(bun "$LEDGER_BIN" render-prompt "$CLAIM_ID" --worker "$WORKER" "${DB_FLAG[@]}")"

USER_PROMPT="Task ${CLAIM_ID}. Run \`bun ${LEDGER_BIN} ${DB_FLAG[*]} show ${CLAIM_ID}\` to
read it, then execute. On terminal state, ask bookie to update (merged + evidence
+ pr, or failed + evidence, or decompose into HITL children). Clean up worktree
before exit. tmux dies on exit; factory respawns if more work."

exec "$CLAUDE" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT"
