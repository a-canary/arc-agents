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

# Headless reconcile decision (pure: stdin args → "review"|"failed" on stdout).
# Extracted so it can be unit-tested by sourcing this script with
# ARC_WORKER_SHELL_SOURCE_ONLY=1 (which returns before any claim/exec).
#
# Rule: committed work ALWAYS advances to `review`, regardless of the agent's
# exit code — a non-zero exit with real commits is salvageable, not a failure.
# The exit code only decides the outcome when there are no commits: a clean
# exit with nothing committed is still `failed` (the agent produced nothing to
# review and the row must leave `claimed`).
#   $1 = agent exit code (deliberately NOT consulted once commits>0), $2 = commits ahead of main
reconcile_decision() {
  local commits="$2"
  if [[ "$commits" -gt 0 ]]; then
    echo review
  else
    echo failed
  fi
}

# Per-worker logfile for the headless child's stdout/stderr (Gap 1: M-0002
# observability — a stalled headless worker otherwise leaves no trail, since it
# inherits only the tmux pane TTY). Pure: $1=worker name → path on stdout.
# Honors XDG_CACHE_HOME, falls back to ~/.cache.
worker_log_path() {
  local cache="${XDG_CACHE_HOME:-}"
  [ -z "$cache" ] && cache="${HOME}/.cache"
  echo "${cache}/arc-workers/${1}.log"
}

# Wall-clock stall bound (seconds) for the headless child (Gap 2). pi has no
# read/stall timeout, so a dropped upstream LLM stream epoll-hangs it forever;
# wrapping it in `timeout` makes a wedged worker self-terminate → the post-exit
# reconciler fires → the pool slot frees, instead of squatting until the
# factory's 4hr reap. Pure: echoes the effective timeout on stdout.
#
# ARC_WORKER_STALL_TIMEOUT overrides the default, but ONLY if it's a positive
# integer — a garbage value must fall back to the default rather than silently
# disabling the guard (a bad arg makes `timeout` error out and skip the wrap).
# Default 1800s: comfortably over a slow-but-live turn, far under the 14400s
# reap so the watchdog (not the reap) frees a hung slot.
stall_timeout_secs() {
  local default=1800
  local override="${ARC_WORKER_STALL_TIMEOUT:-}"
  if [[ "$override" =~ ^[1-9][0-9]*$ ]]; then
    echo "$override"
  else
    echo "$default"
  fi
}

# Resolve the physical repo dir for a row's `project` name (the logical
# identifier in the ledger, e.g. `starlight`). Defaults to the dispatcher's
# $REPO (arc-agents) for unknown projects — so every project that lives in
# arc-agents, arc-webui, arc-skills, etc. behaves exactly as before. No
# regression on the back-compat path.
#
# Cross-project mapping: a row's `project` is a LOGICAL name, not a path.
# Without this indirection the worker always lands in an `arc-agents-` worktree
# under ~/worktrees/, even when the actual code lives elsewhere. Three live
# examples (2026-06-07): project=starlight rows have their code in
# expert-horde, not arc-agents; project=starlight-slm → starlight-slm;
# project=cli-proxy → cli-proxy. Previously a cli-proxy task landed in an empty
# arc-agents checkout and the worker routed around it (observed in task
# 000056-hygiene-cli-proxy-trash-retired-files). See hygiene task
# `improve-architecture-add-cli-proxy-mappi` for the originating fix.
#
# Override contract: env var ARC_PROJECT_REPO_<project> wins over the hardcoded
# table, with dashes in the project name converted to underscores (bash env
# names disallow dashes). Allows operators / per-factory configs to add a new
# project→repo mapping without editing this script. An override pointing at a
# non-existent dir fails LOUDLY via the worktree-add sanity check below — no
# silent squat in $REPO.
#
# Pure: $1 = project name → repo path on stdout. Caller must export REPO
# (this script's own dispatcher dir) before invoking; we use it as the
# fall-through value.
project_repo_path() {
  local project="${1:-}"
  if [[ -z "$project" ]]; then
    echo "${REPO:-}"
    return
  fi
  # Sanitize project name for env-var lookup: bash disallows dashes, so
  # `starlight-slm` → `ARC_PROJECT_REPO_starlight_slm`.
  local env_name="ARC_PROJECT_REPO_${project//-/_}"
  local override="${!env_name:-}"
  if [[ -n "$override" ]]; then
    echo "$override"
    return
  fi
  case "$project" in
    starlight)     echo "/home/aaron/repos/expert-horde" ;;
    starlight-slm) echo "/home/aaron/repos/starlight-slm" ;;
    cli-proxy)     echo "/home/aaron/repos/cli-proxy" ;;
    *)             echo "${REPO:-}" ;;
  esac
}

# Sourced by the test harness — define functions, then stop before doing any
# real work (claim, exec, ledger writes). Production never sets this.
if [[ "${ARC_WORKER_SHELL_SOURCE_ONLY:-}" == "1" ]]; then
  return 0
fi

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
# `project` is optional in the JSON (null when claim races / loses; also
# defensive against future output-shape drift). Pull it AFTER CLAIM_ID so an
# absent `project` key falls back to $REPO, not to a syntax error from an
# unset var.
CLAIM_PROJECT="$(echo "$CLAIM_JSON" | grep -oE '"project":[[:space:]]*"[^"]*"' | sed -E 's/.*"([^"]*)"$/\1/' || true)"

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
# WT_PARENT = the physical git repo dir the worktree should fork from. Default
# is $REPO (the dispatcher's checkout, e.g. arc-agents for the live factory),
# but cross-project rows (project=starlight → expert-horde, etc.) are routed
# to the mapped repo via `project_repo_path`. See the function header for the
# full mapping + override contract.
#
# Slug = CLAIM_ID (already a unique, filesystem-safe kebab task id). Branch
# worker/<slug> off main; worktree at ~/worktrees/<basename-of-WT_PARENT>-<slug>/.
# Idempotent: a pre-existing worktree (re-claim) is reused, not re-added.
WT_PARENT="$(project_repo_path "$CLAIM_PROJECT")"
WT_DIR="${HOME}/worktrees/$(basename "$WT_PARENT")-${CLAIM_ID}"
WT_BRANCH="worker/${CLAIM_ID}"
# Sanity-check the mapped repo dir exists before asking git to worktree-add
# from it. A bad project→repo mapping (typo, repo moved, project retired)
# would otherwise cascade into a silent "git: fatal: not a git repository"
# inside the 2>/dev/null of the fallback chain, leaving the worker with no
# worktree and a confusing cd failure. Fail loud with the offending mapping
# so the operator (or hygiene task) can fix the table. This is the "factory
# fails loud" guard referenced in the improve-architecture-add-cli-proxy-mappi
# brief — a future missing mapping surfaces here, not as a silently-wrong-repo
# worker.
if [[ ! -d "$WT_PARENT" ]]; then
  echo "{\"worker\":\"$WORKER\",\"claimed\":null,\"reason\":\"project-maps-to-missing-dir\",\"project\":\"$CLAIM_PROJECT\",\"wt_parent\":\"$WT_PARENT\"}" >&2
  exit 2
fi
if [ ! -d "$WT_DIR" ]; then
  # -B resets the branch to main's tip if a stale branch lingers from a prior
  # reaped attempt; --force overrides a leftover claude-agent worktree lock.
  if ! git -C "$WT_PARENT" worktree add --force -B "$WT_BRANCH" "$WT_DIR" main 2>/dev/null; then
    # Branch may be checked out elsewhere; fall back to a detached worktree so
    # the worker still isolates rather than silently running in prod root.
    git -C "$WT_PARENT" worktree add --force --detach "$WT_DIR" main
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
${WT_BRANCH}, forked from ${WT_PARENT}, off main) — do all work here, never in
${REPO}. Run \`bun ${LEDGER_BIN} ${DB_FLAG[*]} show ${CLAIM_ID}\`
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
#
# Two guards the interactive path doesn't need (it execs claude, which owns the
# TTY and has its own session timeout + bookie):
#   (1) Log capture (Gap 1): tee the child's combined stdout/stderr to a
#       per-worker logfile so a stalled headless worker leaves a forensic trail.
#   (2) Stall watchdog (Gap 2): wrap the child in `timeout` so a `pi` epoll-hung
#       on a dropped upstream stream self-terminates. `timeout` SIGTERMs at the
#       bound, then SIGKILLs after a 30s grace (-k) in case the hung child
#       ignores SIGTERM. On expiry `timeout` exits 124 — a non-zero rc that
#       flows through reconcile_decision exactly like any crash (commits→review,
#       none→failed), so no special-casing is needed downstream.
LOG_FILE="$(worker_log_path "$WORKER")"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
STALL_SECS="$(stall_timeout_secs)"
set +e
# `timeout` runs the child in its own process group and kills the group on
# expiry. PIPESTATUS[0] is the child/timeout rc (not tee's), so a full disk
# writing the log can't mask the real exit code. `2>&1 |` merges stderr so the
# log is the complete transcript a debugger would want.
timeout -k 30 "$STALL_SECS" "${CMD_PARTS[@]}" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT" 2>&1 \
  | tee "$LOG_FILE"
AGENT_RC=${PIPESTATUS[0]}
set -e

# Did the agent already advance the row past the claim? If so, respect it.
POST_STATE="$(bun "$LEDGER_BIN" show "$CLAIM_ID" "${DB_FLAG[@]}" 2>/dev/null \
  | grep -oE '"state":[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"

if [[ "$POST_STATE" != "claimed" && "$POST_STATE" != "wip" && -n "$POST_STATE" ]]; then
  # Agent self-reported a terminal/review/blocked state — nothing to reconcile.
  exit "$AGENT_RC"
fi

# Reconcile from worktree evidence. Commits on worker/<id> ahead of main mean
# the agent produced work — advance to `review` so a human/merger can pick it
# up, EVEN IF the agent exited non-zero (a crash after committing real work is
# salvageable, not a failure). Only when there are no commits does the exit
# code matter, and then it's always `failed`: the row leaves `claimed` with
# evidence and is NOT recycled.
COMMITS_AHEAD="$(git -C "$WT_DIR" rev-list --count main..HEAD 2>/dev/null || echo 0)"
DECISION="$(reconcile_decision "$AGENT_RC" "$COMMITS_AHEAD")"
if [[ "$DECISION" == "review" ]]; then
  HEAD_SHA="$(git -C "$WT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  EVIDENCE="headless reconcile: agent exited ${AGENT_RC} with ${COMMITS_AHEAD} commit(s) on ${WT_BRANCH} (HEAD ${HEAD_SHA}) but did not self-report; advanced to review (commits salvageable regardless of exit code)."
  bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --state review --evidence "$EVIDENCE" >/dev/null 2>&1 || true
else
  EVIDENCE="headless reconcile: agent exited ${AGENT_RC} with ${COMMITS_AHEAD} commit(s) on ${WT_BRANCH}; no advanceable work, marked failed (was ${POST_STATE:-claimed})."
  bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --state failed --evidence "$EVIDENCE" >/dev/null 2>&1 || true
fi
exit "$AGENT_RC"
