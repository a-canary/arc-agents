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

# systemd --user services inherit a stripped PATH (no ~/.bun/bin), so the
# factory's spawned tmux subshell can't resolve `bun` and dies with exit 127
# before the claim runs. Restore the user's bun install dir if missing.
command -v bun >/dev/null 2>&1 || export PATH="${HOME}/.bun/bin:${PATH}"

# Same stripped-PATH hazard for the headless engine `pi` (two-tier policy
# G-0006: agent-less rows resolve to `pi -p ...`). `node` is on the systemd
# PATH (/usr/local/bin) but its npm-global bin dir — which holds `pi` — is not,
# so the headless child died `pi: command not found` (exit 127) and every
# headless worker got reconciled to `failed`. Derive that dir from node's own
# location (version-agnostic, no hardcoded path) and restore it if `pi` is
# missing. No-op when pi is already resolvable (e.g. interactive shells).
if ! command -v pi >/dev/null 2>&1; then
  _node_bin="$(command -v node 2>/dev/null || true)"
  if [ -n "$_node_bin" ]; then
    _node_global_bin="$(dirname "$_node_bin")/../lib/node_modules/node/bin"
    [ -x "${_node_global_bin}/pi" ] && export PATH="${_node_global_bin}:${PATH}"
  fi
fi

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
# ARC_CLAIM_POOL (preferred) or ARC_CLAIM_TYPE (deprecated alias) restricts
# claim to one pool lane when set by factory for the fast-pass slot.
#
# The SQL literal lives in src/ledger/claim.ts; `ledger claim` executes it
# via claimOnce(). ADR 0001 §"Why not alternatives" requires this bootstrap
# entrypoint to stay bash (no agent process exists yet at claim time), but
# the SQL itself is single-sourced — `bun ledger print-claim-sql` dumps the
# same canonical UPDATE...RETURNING for any ops/debug consumer that wants
# the raw text without re-entering the claim path.
POOL_FLAG=()
CLAIM_POOL="${ARC_CLAIM_POOL:-${ARC_CLAIM_TYPE:-}}"
[ -n "$CLAIM_POOL" ] && POOL_FLAG=(--pool "$CLAIM_POOL")
CLAIM_JSON="$(bun "$LEDGER_BIN" claim "$WORKER" "${DB_FLAG[@]}" "${POOL_FLAG[@]}")"
CLAIM_ID="$(echo "$CLAIM_JSON" | grep -oE '"claimed":[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' || true)"

if [ -z "$CLAIM_ID" ]; then
  echo "{\"worker\":\"$WORKER\",\"claimed\":null,\"reason\":\"race-lost-or-empty\"}"
  exit 0
fi

# Isolate into a per-task worktree BEFORE the agent boots, so every worker
# edits an isolated checkout — never the production repo at $REPO. The
# render-prompt carries no isolation step, and a worker reaches the merger's
# worktree convention only via the merge flow, so isolation must be forced
# here (mechanical, pre-agent — same bootstrap justification as the claim).
#
# Slug = CLAIM_ID (already a unique, filesystem-safe kebab task id). Branch
# worker/<slug> off main; worktree at ~/worktrees/<repo-basename>-<slug>/.
# Idempotent: a pre-existing worktree (re-claim) is reused, not re-added.
REPO_NAME="$(basename "$REPO")"
WT_DIR="${HOME}/worktrees/${REPO_NAME}-${CLAIM_ID}"
WT_BRANCH="worker/${CLAIM_ID}"
if [ ! -d "$WT_DIR" ]; then
  # -B resets the branch to main's tip if a stale branch lingers from a prior
  # reaped attempt; --force overrides a leftover claude-agent worktree lock.
  if ! git -C "$REPO" worktree add --force -B "$WT_BRANCH" "$WT_DIR" main 2>/dev/null; then
    # Branch may be checked out elsewhere; fall back to a detached worktree so
    # the worker still isolates rather than silently running in prod root.
    git -C "$REPO" worktree add --force --detach "$WT_DIR" main
  fi
fi
cd "$WT_DIR"
# Record branch + worktree on the row so reapWorktrees() prunes both after the
# task merges. Bootstrap write (pre-agent), same exception as the claim above;
# all in-session writes still route through the bookie.
bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --branch "$WT_BRANCH" --worktree "$WT_DIR" >/dev/null 2>&1 || true

# Export for Stop hook + claude to see. Stop hook reads ARC_TASK_ID to check terminal state.
export ARC_WORKER_SESSION="$WORKER"
export ARC_TASK_ID="$CLAIM_ID"
export ARC_WORKTREE="$WT_DIR"

# Per-(kind,type) system prompt resolved in TS — see src/worker/templates.ts.
SYS_PROMPT="$(bun "$LEDGER_BIN" render-prompt "$CLAIM_ID" --worker "$WORKER" "${DB_FLAG[@]}")"

USER_PROMPT="Task ${CLAIM_ID}. You are isolated in worktree ${WT_DIR} (branch
${WT_BRANCH}, off main) — do all work here, never in ${REPO}. Run \`bun ${LEDGER_BIN} ${DB_FLAG[*]} show ${CLAIM_ID}\`
to read it, then execute. On terminal state, ask bookie to update (merged +
evidence + pr, or failed + evidence, or decompose into HITL children). tmux
dies on exit; factory respawns if more work."

# Resolve which model/effort to run from the row's agent→profile→alias chain.
ALIAS="$(bun "$LEDGER_BIN" resolve-alias "$CLAIM_ID" "${DB_FLAG[@]}")"
CMD_TEMPLATE="$(bun "$LEDGER_BIN" alias-cmd "$ALIAS")"
# Split the template into argv on whitespace, dropping the {prompt} placeholder token.
# The user turn is then passed as a SINGLE positional argv word — never interpolated
# into a shell-evaluated string (avoids quoting/injection hazards).
read -ra CMD_PARTS <<< "${CMD_TEMPLATE/\{prompt\}/}"
# Preserve CLAUDE_BIN override: if the first word of the template is "claude" and
# $CLAUDE differs from it (i.e. CLAUDE_BIN is set), substitute $CLAUDE as argv[0].
if [[ "${CMD_PARTS[0]:-}" == "claude" ]]; then
  CMD_PARTS[0]="$CLAUDE"
fi

# Engine discriminator (two-tier policy G-0006):
#   - interactive `claude` lives many turns and self-reports its terminal state
#     to the ledger via the bookie subagent. Hand the TTY over with exec — the
#     shell is replaced and the row is the agent's responsibility.
#   - headless `pi -p` is single-shot: it answers and exits in one process,
#     WITHOUT a bookie round-trip. If we exec it, the session dies with the row
#     still `state='claimed'`, and reapOrphanClaims (factory.ts) resets it to
#     `ready` → the factory respawns a worker that re-claims the SAME row → a
#     respawn loop that burns API budget on rows that never progress.
# So for a headless engine we do NOT exec: run the agent as a CHILD, then a
# deterministic post-exit reconciler advances the row off `claimed` based on
# worktree evidence — but only if the agent didn't already advance it (we
# re-read state first, so a self-reporting agent always wins). These writes
# reuse the sanctioned bootstrap-exception ledger path (same as the claim and
# the --branch/--worktree write above); they are pre/post-agent mechanical
# writes, not in-session writes, so the "all in-session writes via bookie"
# rule is preserved.
HEADLESS=0
for _arg in "${CMD_PARTS[@]}"; do
  if [[ "$_arg" == "-p" ]]; then HEADLESS=1; break; fi
done

if [[ "$HEADLESS" != "1" ]]; then
  # Interactive path — unchanged. Agent owns its terminal state via the bookie.
  exec "${CMD_PARTS[@]}" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT"
fi

# Headless path — run as a child, capture rc, then reconcile the row.
set +e
"${CMD_PARTS[@]}" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT"
AGENT_RC=$?
set -e

# Did the agent already advance the row past the claim? If so, respect it.
POST_STATE="$(bun "$LEDGER_BIN" show "$CLAIM_ID" "${DB_FLAG[@]}" 2>/dev/null \
  | grep -oE '"state":[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"

if [[ "$POST_STATE" != "claimed" && "$POST_STATE" != "wip" && -n "$POST_STATE" ]]; then
  # Agent self-reported a terminal/review/blocked state — nothing to reconcile.
  exit "$AGENT_RC"
fi

# Reconcile from worktree evidence. Commits on worker/<id> ahead of main mean
# the agent produced work even if it never called the bookie → advance to
# `review` so a human/merger can pick it up. No commits (or the agent errored)
# → `failed` with evidence, so the row leaves `claimed` and is NOT recycled.
COMMITS_AHEAD="$(git -C "$WT_DIR" rev-list --count main..HEAD 2>/dev/null || echo 0)"
if [[ "$AGENT_RC" -eq 0 && "$COMMITS_AHEAD" -gt 0 ]]; then
  HEAD_SHA="$(git -C "$WT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  EVIDENCE="headless reconcile: agent exited 0 with ${COMMITS_AHEAD} commit(s) on ${WT_BRANCH} (HEAD ${HEAD_SHA}) but did not self-report; advanced to review."
  bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --state review --evidence "$EVIDENCE" >/dev/null 2>&1 || true
else
  EVIDENCE="headless reconcile: agent exited ${AGENT_RC} with ${COMMITS_AHEAD} commit(s) on ${WT_BRANCH}; no advanceable work, marked failed (was ${POST_STATE:-claimed})."
  bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --state failed --evidence "$EVIDENCE" >/dev/null 2>&1 || true
fi
exit "$AGENT_RC"
