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
# ARC_CLAIM_TYPE (set by factory for fast-pass pool) restricts claim to one type.
TYPE_FLAG=()
[ -n "${ARC_CLAIM_TYPE:-}" ] && TYPE_FLAG=(--type "${ARC_CLAIM_TYPE}")
CLAIM_JSON="$(bun "$LEDGER_BIN" claim "$WORKER" "${DB_FLAG[@]}" "${TYPE_FLAG[@]}")"
CLAIM_ID="$(echo "$CLAIM_JSON" | grep -oE '"claimed":[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' || true)"

if [ -z "$CLAIM_ID" ]; then
  echo "{\"worker\":\"$WORKER\",\"claimed\":null,\"reason\":\"race-lost-or-empty\"}"
  exit 0
fi

# Export for Stop hook + claude to see. Stop hook reads ARC_TASK_ID to check terminal state.
export ARC_WORKER_SESSION="$WORKER"
export ARC_TASK_ID="$CLAIM_ID"

PROMPT="You are arc-agents worker ${WORKER}. Task id=${CLAIM_ID}.

Steps:
1. Run \`bun ${LEDGER_BIN} ${DB_FLAG[*]} show ${CLAIM_ID}\` to read the task.
2. Provision a worktree under ~/worktrees/ if the task needs code changes.
3. Execute the task. All ledger WRITES (update, decompose, event, create) must
   be delegated to the bookie subagent. Reads (show, list) are fine direct.
4. On completion: ask bookie to update state=merged with --evidence <one-line>
   and --pr <url-or-branch>. On unrecoverable failure: state=failed with
   evidence. If you discover sub-work a human must do: ask bookie to decompose
   into HITL deps (state=blocked).
5. Clean up: remove your worktree (\`git worktree remove\`), no uncommitted changes.

When done, exit naturally — the Stop hook will verify terminal state and let
the session end. tmux session dies → factory respawns next tick if more work."

exec "$CLAUDE" \
  --append-system-prompt "kind=worker; worker=${WORKER}; task=${CLAIM_ID}; ephemeral; autonomous AFK; commit as the configured git user (\`git config user.name\`); route all ledger writes through bookie subagent" \
  "$PROMPT"
