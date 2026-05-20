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

# Last-resort scrollback capture: if the tee's pipe gets SIGKILLed or
# broken, the logfile is 0 bytes even when the pane has output. Pure:
# $1=worker, $2=logfile → appends, no-op when not in a tmux session.
capture_scrollback_to_log() {
  local worker="$1" log="$2"
  [ -n "$log" ] && tmux has-session -t "$worker" 2>/dev/null \
    && tmux capture-pane -p -t "$worker" -S -2000 >> "$log" 2>/dev/null \
    || true
  return 0
}

# Real-time pane capture via `tmux pipe-pane`. The factory runs each worker
# inside its own tmux session (e.g. `arc-worker-a-0s5tnm`); this attaches
# a pipe that mirrors the pane's content to the per-worker logfile AS IT
# IS RENDERED, including interactive TUI output (`claude` writes to
# /dev/tty, invisible to `tee`) and headless stdout (`pi -p`). The pipe is
# attached to the PANE, not the script's process tree, so it survives the
# interactive `exec "${CMD_PARTS[@]}"` (which replaces this script with
# claude) AND the factory's SIGKILL reap (the pipe's `-o` flag closes it
# when the pane exits, flushing whatever was buffered to disk). Without
# this, an interactive worker that exits within 10-30s of its factory spawn
# (the hygiene-claim profile) has a logfile containing only the bootstrap
# "Model not found" warning — currently 85 bytes, vs. 0 for hygiene claims
# where the capture_scrollback_to_log fallback races the factory reap.
# Pure: $1=worker, $2=logfile → no-op when not in a tmux session, never
# creates the logfile on its own (mkdir is the caller's job).
setup_pipe_pane() {
  local worker="$1" log="$2"
  [ -n "$log" ] && tmux has-session -t "$worker" 2>/dev/null \
    && tmux pipe-pane -t "$worker" -o "cat >> $log" 2>/dev/null \
    || true
  return 0
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

# Resolve the target REPO for a claimed row. Honors ARC_PROJECT_REPO_<UPPER>
# env overrides; defaults to ~/repos/<project>/. Pure: $1 = project name →
# absolute REPO path on stdout. Falls back to the script's own location
# (~/repos/arc-agents) for an empty/unset project so the prior hardcoded
# behavior survives as a no-regression safety net for legacy rows.
#
# Why env override + ~/repos default: rows may name a project whose working
# clone lives at a non-default location — a bare clone on a fast SSD, a fork
# under a different org, a CI cache mirror. ARC_PROJECT_REPO_<UPPER> lets
# the factory (or a test harness) redirect without editing this script. The
# default ~/repos/<project>/ mirrors the convention `factory.ts` and the
# director's `CHOICES.md` directories already follow.
#
# Hyphens in the project name become underscores in the env var (so
# "cli-proxy" → ARC_PROJECT_REPO_CLI_PROXY, "starlight-slm" →
# ARC_PROJECT_REPO_STARLIGHT_SLM). This matches the bash uppercase idiom
# shells and CI configs already use for project-scoped knobs.
resolve_repo() {
  local project="$1"
  if [ -z "$project" ]; then
    cd "$(dirname "$0")/.." && pwd
    return
  fi

  # Env override takes priority even for hardcoded projects — lets the factory
  # or a test harness redirect without editing this script.
  local var
  var="ARC_PROJECT_REPO_$(echo "$project" | tr '[:lower:]-' '[:upper:]_')"
  local override="${!var:-}"
  if [ -n "$override" ]; then
    echo "$override"
    return
  fi

  # Hardcoded project → repo mappings (hygiene: keep synced with task brief).
  # cli-proxy: /home/aaron/repos/cli-proxy
  # expert-horde: /home/aaron/repos/expert-horde
  # starlight: /home/aaron/repos/expert-horde  (same checkout, different project name)
  case "$project" in
    cli-proxy)     echo "${HOME}/repos/cli-proxy";     return ;;
    expert-horde)  echo "${HOME}/repos/expert-horde";  return ;;
    starlight)     echo "${HOME}/repos/expert-horde";  return ;;
  esac

  echo "${HOME}/repos/${project}"
}

# Prepend the dir holding a globally-installed `pi` to PATH if `pi` isn't
# already resolvable. Used to survive the stripped PATH that systemd --user
# services inherit (no ~/.npm-global/bin). Probes, in priority order:
#   1. node's sibling global bin (root-prefix npm)
#   2. `npm prefix -g`/bin — authoritative for the active npm, and the ONLY
#      probe that catches a per-user prefix (`npm config set prefix
#      ~/.npm-global`, the recommended no-sudo install on macOS/Linux). The
#      node-sibling heuristic alone missed it, so headless workers on such hosts
#      died exit 127 `pi: command not found`.
#   3. ~/.npm-global/bin — static fallback for when npm isn't on the PATH to
#      answer `prefix -g`.
# No-op when pi is already resolvable (e.g. interactive shells). Pure + sourced
# so it can be unit-tested via ARC_WORKER_SHELL_SOURCE_ONLY=1.
ensure_pi_on_path() {
  command -v pi >/dev/null 2>&1 && return 0
  local candidates=() node_bin npm_prefix d
  node_bin="$(command -v node 2>/dev/null || true)"
  [ -n "$node_bin" ] && candidates+=( "$(dirname "$node_bin")/../lib/node_modules/node/bin" )
  if command -v npm >/dev/null 2>&1; then
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    [ -n "$npm_prefix" ] && candidates+=( "${npm_prefix}/bin" )
  fi
  candidates+=( "${HOME}/.npm-global/bin" )
  for d in "${candidates[@]}"; do
    if [ -x "${d}/pi" ]; then export PATH="${d}:${PATH}"; return 0; fi
  done
  return 0
}

# Sourced by the test harness — define functions, then stop before doing any
# real work (claim, exec, ledger writes). Production never sets this.
if [[ "${ARC_WORKER_SHELL_SOURCE_ONLY:-}" == "1" ]]; then
  return 0
fi

# systemd --user services inherit a stripped PATH (no ~/.bun/bin or ~/.local/bin),
# so the spawned tmux subshell cannot resolve `bun` or `claude` and dies before
# exec. Restore both install dirs if missing.
command -v bun >/dev/null 2>&1 || export PATH="${HOME}/.bun/bin:${PATH}"
command -v claude >/dev/null 2>&1 || export PATH="${HOME}/.local/bin:${PATH}"

# Headless engine `pi` (two-tier policy G-0006: agent-less rows → `pi -p ...`)
# has the same stripped-PATH hazard as bun above; see ensure_pi_on_path.
ensure_pi_on_path

WORKER="${1:?worker name required}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER_BIN="${REPO}/bin/ledger.ts"
CLAUDE="${CLAUDE_BIN:-claude}"

# arctest-* workers are reserved for test harnesses. They must never claim
# against the canonical ledger — a leaked ARC_LEDGER_DB env var (or its
# absence, which defaults to canon) would otherwise let a test fixture
# corrupt production rows. Refuse before any ledger write.
#
# CANON_DB uses ARC_VAULT_HOME with XDG_DATA_HOME fallback (I-0012).
_resolve_arc_vault_home() {
  local home="${HOME}"
  local xdg="${XDG_DATA_HOME:-${home}/.local/share}"
  local xdg_vault="${xdg}/arc/vault"
  # Prefer existing legacy path if XDG path is unpopulated
  if [[ -d "${home}/vault" ]] && [[ ! -d "$xdg_vault" ]]; then
    echo "${home}/vault"
  else
    echo "$xdg_vault"
  fi
}
if [[ "${WORKER:-}" == arctest-* ]]; then
  CANON_DB="${ARC_VAULT_HOME:-$(_resolve_arc_vault_home)}/ledger.db"
  EFFECTIVE_DB="${ARC_LEDGER_DB:-$CANON_DB}"
  if [[ "$EFFECTIVE_DB" == "$CANON_DB" ]]; then
    echo "{\"worker\":\"$WORKER\",\"claimed\":null,\"reason\":\"arctest-claim-against-canon-refused\"}" >&2
    exit 2
  fi
fi

DB_FLAG=()
# ARC_LEDGER_DB overrides everything; otherwise fall back to resolveVaultHome()/ledger.db
if [ -n "${ARC_LEDGER_DB:-}" ]; then
  DB_FLAG=(--db "${ARC_LEDGER_DB}")
elif [ -n "${ARC_VAULT_HOME:-}" ]; then
  DB_FLAG=(--db "${ARC_VAULT_HOME}/ledger.db")
else
  # shellcheck disable=SC2046
  DB_FLAG=(--db "$(_resolve_arc_vault_home)/ledger.db")
fi

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

# Project-aware REPO routing. Hardcoding REPO to this script's own location
# (~/repos/arc-agents) made every worker edit arc-agents regardless of the
# row's `project` field (Pattern 1, analysis-1780502957.md). After the claim
# succeeds, read the row's project via the same `bun ledger show` call the
# test fixtures use, then resolve to ~/repos/<project>/ (or the
# ARC_PROJECT_REPO_<UPPER> override). $REPO above stays pointed at
# ~/repos/arc-agents/ — we still need the local bin/ledger.ts — so the
# worktree parent is a NEW variable, WT_REPO, used only by the git worktree
# commands and the user prompt. Empty/unset project falls back to $REPO
# (the script's own location) for legacy rows.
PROJECT="$(bun "$LEDGER_BIN" show "$CLAIM_ID" "${DB_FLAG[@]}" 2>/dev/null \
  | grep -oE '"project":[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"
WT_REPO="$(resolve_repo "$PROJECT")"

# Isolate into a per-task worktree BEFORE the agent boots, so every worker
# edits an isolated checkout — never the production repo at $WT_REPO. The
# render-prompt carries no isolation step, and a worker reaches the merger's
# worktree convention only via the merge flow, so isolation must be forced
# here (mechanical, pre-agent — same bootstrap justification as the claim).
#
# Slug = CLAIM_ID (already a unique, filesystem-safe kebab task id). Branch
# worker/<slug> off main; worktree at ~/worktrees/<repo-basename>-<slug>/.
# Idempotent: a pre-existing worktree (re-claim) is reused, not re-added.
# A row whose project resolves to a repo that doesn't exist on this host (fresh
# user who hasn't cloned it, or a name typo) would otherwise fail deep inside
# `git -C "$WT_REPO" worktree add` with a cryptic "No such file or directory"
# and strand the claimed row. Fail fast with an actionable message naming the
# missing path AND the env var that overrides it.
if [ ! -d "$WT_REPO" ]; then
  _ov_var="ARC_PROJECT_REPO_$(echo "${PROJECT:-}" | tr '[:lower:]-' '[:upper:]_')"
  echo "worker-shell: project repo not found: '$WT_REPO'" >&2
  echo "  clone it there, or set ${_ov_var}=/path/to/repo to point at an existing checkout." >&2
  exit 1
fi
REPO_NAME="$(basename "$WT_REPO")"
WT_DIR="${HOME}/worktrees/${REPO_NAME}-${CLAIM_ID}"
WT_BRANCH="worker/${CLAIM_ID}"
if [ ! -d "$WT_DIR" ]; then
  # -B resets the branch to main's tip if a stale branch lingers from a prior
  # reaped attempt; --force overrides a leftover claude-agent worktree lock.
  if ! git -C "$WT_REPO" worktree add --force -B "$WT_BRANCH" "$WT_DIR" main 2>/dev/null; then
    # Branch may be checked out elsewhere; fall back to a detached worktree so
    # the worker still isolates rather than silently running in prod root.
    git -C "$WT_REPO" worktree add --force --detach "$WT_DIR" main
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
${WT_BRANCH}, off main) — do all work here, never in ${WT_REPO}. Run \`bun ${LEDGER_BIN} ${DB_FLAG[*]} show ${CLAIM_ID}\`
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
  # The pipe-pane is attached to the PANE (not the process), so the pipe
  # survives this `exec` and continues mirroring the tmux pane (now running
  # claude) to the logfile for the worker's full lifetime.
  exec "${CMD_PARTS[@]}" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT"
fi

# Resolve the per-worker logfile path BEFORE we hand the TTY over, so the
# pipe-pane is attached to the pane that claude is about to take over (the
# pipe is on the pane, not the process, so order is in practice irrelevant —
# but doing it here keeps the call site obvious and pinpoints the failure
# mode to "if you got here, the pipe is wired"). Also keeps the headless
# path's prior `tee` removed in favor of the single pane-side pipe (no
# duplicate content, single source of capture truth).
LOG_FILE="$(worker_log_path "$WORKER")"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
setup_pipe_pane "$WORKER" "$LOG_FILE"

# Headless path — run as a child, capture rc, then reconcile the row.
#
# Two guards the interactive path doesn't need (it execs claude, which owns the
# TTY and has its own session timeout + bookie):
#   (1) Log capture (Gap 1): pane-side `tmux pipe-pane` (set above) mirrors
#       the worker's tmux pane to the per-worker logfile. Replaces the prior
#       `tee` which only saw stdout (no TUI) and which could be SIGKILLed
#       before flushing on a factory reap. `capture_scrollback_to_log` (below)
#       remains as a last-resort fallback for cases where pipe-pane never
#       attached (tmux server down at spawn, race on the pipe-pane call, etc).
#   (2) Stall watchdog (Gap 2): wrap the child in `timeout` so a `pi` epoll-hung
#       on a dropped upstream stream self-terminates. `timeout` SIGTERMs at the
#       bound, then SIGKILLs after a 30s grace (-k) in case the hung child
#       ignores SIGTERM. On expiry `timeout` exits 124 — a non-zero rc that
#       flows through reconcile_decision exactly like any crash (commits→review,
#       none→failed), so no special-casing is needed downstream.
STALL_SECS="$(stall_timeout_secs)"
set +e
# `timeout` runs the child in its own process group and kills the group on
# expiry. `$?` is the child/timeout rc (no tee in the pipe anymore). `2>&1`
# merges stderr into the pane (pipe-pane sees both); the redundant stdout is
# intentionally not piped to `tee` (pipe-pane already captures it — tee would
# duplicate every line).
timeout -k 30 "$STALL_SECS" "${CMD_PARTS[@]}" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT" 2>&1
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
capture_scrollback_to_log "$WORKER" "$LOG_FILE"
exit "$AGENT_RC"
