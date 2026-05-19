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

# arctest-* workers are reserved for test harnesses. They must never claim
# against the canonical ledger — a leaked ARC_LEDGER_DB env var (or its
# absence, which defaults to canon) would otherwise let a test fixture
# corrupt production rows. Refuse before any ledger write.
if [[ "${WORKER:-}" == arctest-* ]]; then
  CANON_DB="${HOME}/vault/ledger.db"
  EFFECTIVE_DB="${ARC_LEDGER_DB:-$CANON_DB}"
  if [[ "$EFFECTIVE_DB" == "$CANON_DB" ]]; then
    echo "{\"worker\":\"$WORKER\",\"claimed\":null,\"reason\":\"arctest-claim-against-canon-refused\"}" >&2
    exit 2
  fi
fi

DB_FLAG=()
[ -n "${ARC_LEDGER_DB:-}" ] && DB_FLAG=(--db "${ARC_LEDGER_DB}")

# Atomic claim. Race-safe — losers get claimed=null and exit.
# ARC_CLAIM_TYPE (set by factory for fast-pass pool) restricts claim to one type.
#
# The SQL literal lives in src/ledger/claim.ts; `ledger claim` executes it
# via claimOnce(). ADR 0001 §"Why not alternatives" requires this bootstrap
# entrypoint to stay bash (no agent process exists yet at claim time), but
# the SQL itself is single-sourced — `bun ledger print-claim-sql` dumps the
# same canonical UPDATE...RETURNING for any ops/debug consumer that wants
# the raw text without re-entering the claim path.
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

# Per-(kind,type) system prompt resolved in TS — see src/worker/templates.ts.
SYS_PROMPT="$(bun "$LEDGER_BIN" render-prompt "$CLAIM_ID" --worker "$WORKER" "${DB_FLAG[@]}")"

USER_PROMPT="Task ${CLAIM_ID}. Run \`bun ${LEDGER_BIN} ${DB_FLAG[*]} show ${CLAIM_ID}\` to
read it, then execute. On terminal state, ask bookie to update (merged + evidence
+ pr, or failed + evidence, or decompose into HITL children). Clean up worktree
before exit. tmux dies on exit; factory respawns if more work."

exec "$CLAUDE" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT"
