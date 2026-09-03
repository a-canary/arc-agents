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

# shellcheck source=../src/project-repo-map.sh
source "$(dirname "${BASH_SOURCE[0]}")/../src/project-repo-map.sh"

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

# Structured salvage payload (pure: args → JSON on stdout). Emitted as a
# `salvage` ledger event alongside the prose evidence when a headless worker
# leaves commits but no terminal self-report, so a recovery worker/gate reads
# machine-readable base/head/commits/branch/exit_code/pr_url instead of parsing
# English. Empty pr_url → JSON null (PR not discovered). Logged under the `note`
# event kind (the schema CHECK-constrained kind set); consumers match the inner
# `"kind":"salvage"` marker in the payload.
#   $1=base $2=head $3=commits $4=branch $5=exit_code $6=pr_url
salvage_payload_json() {
  jq -nc \
    --arg base "$1" \
    --arg head "$2" \
    --argjson commits "$3" \
    --arg branch "$4" \
    --argjson exit_code "$5" \
    --arg pr "${6:-}" \
    '{
      kind: "salvage",
      base: $base,
      head: $head,
      commits: $commits,
      branch: $branch,
      exit_code: $exit_code,
      pr_url: (if $pr == "" then null else $pr end),
      reason: "commits present, no terminal self-report"
    }'
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

  # Shared project -> repo-dir-name map (src/project-repo-map.sh), for
  # projects whose repo dir name differs from the project name.
  local mapped
  mapped="$(project_repo_map_lookup "$project")"
  if [ -n "$mapped" ]; then
    echo "${HOME}/repos/${mapped}"
    return
  fi

  echo "${HOME}/repos/${project}"
}

# Extract the first string-valued `"<field>": "<value>"` out of a `ledger show`
# (or `ledger claim`) JSON blob. The one place the fragile grep/sed idiom lives
# — every field read (project, parent_id, claimed, state) goes through here, so
# the parsing can be fixed/hardened in a single spot. Pure: $1=field, $2=json →
# value on stdout, empty when absent/null. Unit-tested via the named wrappers
# below and the claim/state read sites.
json_string_field() {
  echo "$2" | grep -oE "\"$1\":[[:space:]]*\"[^\"]+\"" | head -n1 | sed -E 's/.*"([^"]+)"$/\1/' || true
}

# Named wrappers kept for the parent-walk loop's readability + existing tests.
extract_project_field()   { json_string_field project "$1"; }
extract_parent_id_field() { json_string_field parent_id "$1"; }

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
  # Local (non-global) install: `npm i @mariozechner/pi-coding-agent` drops the
  # `pi` symlink under ~/node_modules/.bin, which no global prefix probe finds.
  candidates+=( "${HOME}/node_modules/.bin" )
  for d in "${candidates[@]}"; do
    if [ -x "${d}/pi" ]; then export PATH="${d}:${PATH}"; return 0; fi
  done
  return 0
}

# `claude-afk` is the typical Nth-of-N candidate in the `fast`/`minimax-build`
# alias groups (G-0006 N-tier escalation). It lives in `~/.local/bin/` (or
# `~/node_modules/.bin` for a per-worktree install) while `claude` itself is
# symlinked into `/usr/local/bin/claude` — so the `command -v claude` restore
# below never fires when `claude` resolves from the system path, leaving
# `claude-afk` unreachable inside the factory-spawned tmux subshell. Net: every
# alias failover that lists a `claude-afk` candidate silently degenerates to
# N-1 candidates tested; rows go `failed` with `all N candidate engine(s) for
# alias 'X' produced no work` (analysis-1783332184.md Pattern 1: 21 events, 8
# projects, 30d). Mirror ensure_pi_on_path — same install-dir probes, never
# fatal. Defined before the ARC_WORKER_SHELL_SOURCE_ONLY=1 short-circuit so
# the test harness can call it on a stripped PATH.
ensure_claude_afk_on_path() {
  command -v claude-afk >/dev/null 2>&1 && return 0
  local d
  for d in "${HOME}/.local/bin" "${HOME}/node_modules/.bin"; do
    if [ -x "${d}/claude-afk" ]; then
      export PATH="${d}:${PATH}"
      return 0
    fi
  done
  return 0
}

# Discover the repo's default branch (e.g. `main`, `master`, `develop`). The
# factory previously hardcoded `main` in three sites (fast_forward_main,
# worktree add base, BASELINE_SHA fallback) — arc-webui's GitHub default is
# `master` (analysis-1783678328.md Pattern 2, 1 confirmed ghost merge
# `000101-hygiene-arc-webui-improve-architecture`), so workers branching off
# `main` produced merges invisible on `master`. Mirror the resolve_repo
# convention: probe three sources in priority order, fall back to `main` so
# the script's own repo (and the 12 other `default=main` repos in the estate)
# don't regress. Pure: $1 = repo path → branch name on stdout. Empty stdout
# signals "could not determine" — callers must default to `main` themselves.
default_branch_for_repo() {
  local repo="$1"
  [ -d "${repo}/.git" ] || { return 0; }
  # (1) Fastest path: Git tracks the remote's HEAD via refs/remotes/origin/HEAD,
  # populated by `git remote set-head origin --auto` (or any `git clone`). This
  # is a symbolic ref, so read with `git symbolic-ref`.
  local sym
  sym="$(git -C "$repo" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$sym" ]; then
    echo "${sym##*/}"
    return 0
  fi
  # (2) Slow path: query GitHub's API. Same answer as (1) when (1) is set,
  # but covers repos where nobody has run `remote set-head` (rare in
  # production, common in fresh test fixtures). `gh` is in the factory's PATH.
  local gh_default
  gh_default="$(gh repo view "$repo" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || true)"
  if [ -n "$gh_default" ]; then
    echo "$gh_default"
    return 0
  fi
  # (3) Last-ditch probe: whichever branch `HEAD` tracks when local is on the
  # default. The script's own repo + every other `default=main` repo hits
  # this path. We still emit nothing here so the caller's `${VAR:-main}`
  # fallback wins.
  return 0
}

# `cli-agent` is the AXI router CLI for cli-proxy — post-2026-07-10 ruling,
# arc-agents' exec_cli_alias points every alias at `cli-agent --pool <name>`.
# Lives in the same install dirs as `pi` (both are npm/node-symlinks under
# ~/node_modules/.bin or globally under ~/.local/bin). Mirror ensure_pi_on_path
# — same probes, never fatal. Without this, systemd-stripped-PATH workers
# can't resolve `cli-agent` and degenerate to zero candidates.
ensure_cli_agent_on_path() {
  command -v cli-agent >/dev/null 2>&1 && return 0
  local d node_bin npm_prefix candidates
  node_bin="$(command -v node 2>/dev/null || true)"
  candidates=()
  [ -n "$node_bin" ] && candidates+=( "$(dirname "$node_bin")/../lib/node_modules/node/bin" )
  if command -v npm >/dev/null 2>&1; then
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    [ -n "$npm_prefix" ] && candidates+=( "${npm_prefix}/bin" )
  fi
  candidates+=( "${HOME}/.local/bin" "${HOME}/node_modules/.bin" )
  for d in "${candidates[@]}"; do
    if [ -x "${d}/cli-agent" ]; then export PATH="${d}:${PATH}"; return 0; fi
  done
  return 0
}

# Fast-forward the given repo's default branch (e.g. local `main` or
# `master`) to `origin/<default>`. Closes the "local main N behind origin"
# pattern documented in analysis-1782813826.md §"Pattern 4 follow-up" — the
# same follow-up was recommended in 000103 (analysis-1782187417.md Pattern 3)
# but never filed until now. Worker-shell.sh is the structural fix: any
# worker that claims against the repo observes a current default branch
# BEFORE its worktree is added, which keeps `merge-guard`'s
# `--local-merged-sha` truth-check and the `git worktree add -B <branch>
# ... <default>` base accurate. analysis-1783678328.md Pattern 2 widened the
# fix: the literal `main` here used to mismatch arc-webui's actual default
# (`master`), so workers branched off the wrong base and their merges were
# invisible on production. Pure: $1 = repo path → 0 on ff/no-op, non-zero on
# missing-repo or no-remote (caller treats non-zero as "skip ff, continue";
# not fatal). No-op when origin/<default> is already reachable from the local
# default branch.
#
# ponytail: guarded `fetch + merge --ff-only` — checks remote existence,
# confirms local default is at-or-behind origin/default via ancestry check
# before merging. When local default is ahead of or diverged from
# origin/default, merge is skipped entirely (return 0). A real merge
# conflict is impossible because local default was at-or-behind origin/default
# by construction (we're racing only the cron-pushed merges). If conflict
# ever appears (e.g. origin moves between fetch and merge), the helper
# returns non-zero and the worker boots on the stale-but-known default —
# same as today, just with one fewer race window.
fast_forward_main() {
  local repo="$1"
  [ -d "${repo}/.git" ] || return 1
  local default_branch
  default_branch="$(default_branch_for_repo "$repo")"
  default_branch="${default_branch:-main}"
  # Bail when there's no `origin` remote to fetch — common for fresh local
  # clones without a remote, or hygiene rows against a worktree-only repo.
  git -C "$repo" remote get-url origin >/dev/null 2>&1 || return 1
  # Fast-forward only when there's actually something to ff: local default
  # must be an ancestor of origin/<default> (i.e., origin has commits we
  # don't). If they're equal or local is ahead, `merge --ff-only` would
  # refuse — skip. This ancestry pre-check also covers the diverged case
  # (local is not an ancestor of origin), where merge --ff-only would fail.
  git -C "$repo" fetch -q origin "$default_branch" 2>/dev/null || return 1
  if git -C "$repo" merge-base --is-ancestor "$default_branch" "origin/$default_branch" 2>/dev/null; then
    git -C "$repo" merge --ff-only "origin/$default_branch" 2>/dev/null || return 1
  fi
  return 0
}

# Sourced by the test harness — define functions, then stop before doing any
# real work (claim, exec, ledger writes). Production never sets this.
if [[ "${ARC_WORKER_SHELL_SOURCE_ONLY:-}" == "1" ]]; then
  return 0
fi

# systemd --user services inherit a stripped PATH (no ~/.bun/bin or ~/.local/bin),
# so the spawned tmux subshell cannot resolve `bun` or `claude` and dies before
# exec. Unconditionally prepend install dirs so user installs take precedence.
export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:${PATH}"

# The spawned `bash worker-shell.sh` is non-interactive, so ~/.bashrc never
# runs and pass-sourced keys are absent. The tmux server env doesn't carry
# them either. Pull from pass (canonical store) when unset:
# - CLAUDE_CODE_OAUTH_TOKEN: headless `claude` auth (credentials.json can be
#   wiped; inference-only token, no refresh).
# - MINIMAX_API_KEY: bench SOLVE arms run `pi -p --model minimax-m3`.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && command -v pass >/dev/null 2>&1; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(pass show api/claude/oauth-token 2>/dev/null || true)"
fi
if [ -z "${MINIMAX_API_KEY:-}" ] && command -v pass >/dev/null 2>&1; then
  export MINIMAX_API_KEY="$(pass show api/minimax/api-key 2>/dev/null || true)"
fi

# Headless engine `pi` (two-tier policy G-0006: agent-less rows → `pi -p ...`)
# has the same stripped-PATH hazard as bun above; see ensure_pi_on_path.
# `cli-agent` is the post-2026-07-10 successor for alias→cmdline resolution —
# every fast/smart/opus-max/minimax-build alias now routes through it, so the
# stripped-PATH guard must extend to it too.
ensure_pi_on_path
ensure_claude_afk_on_path
ensure_cli_agent_on_path

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
CLAIM_ID="$(json_string_field claimed "$CLAIM_JSON")"

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
# commands and the user prompt. An empty project on the claimed row itself
# walks up parent_id (hygiene rows are frequently filed against a PRD/parent
# that DOES carry the project) before falling back to $REPO — a row with an
# empty project and no ancestor with one is legacy and still routes to the
# script's own location.
PROJECT=""
LOOKUP_ID="$CLAIM_ID"
for _ in 1 2 3 4 5; do
  [ -z "$LOOKUP_ID" ] && break
  SHOW_JSON="$(bun "$LEDGER_BIN" show "$LOOKUP_ID" "${DB_FLAG[@]}" 2>/dev/null || true)"
  PROJECT="$(extract_project_field "$SHOW_JSON")"
  [ -n "$PROJECT" ] && break
  LOOKUP_ID="$(extract_parent_id_field "$SHOW_JSON")"
done
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
  # Never exit holding the claim — block the row and clear claimed_by so it doesn't
  # thrash the ready queue on every factory respawn. Bootstrap write, same
  # pre-agent exception as the claim above.
  bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --state blocked \
    --evidence "worker-shell: project '$PROJECT' has no repo mapping ('$WT_REPO' not found). Set ${_ov_var}=/path/to/repo or retag the project." \
    >/dev/null 2>&1 || true
  exit 1
fi
REPO_NAME="$(basename "$WT_REPO")"
WT_DIR="${HOME}/worktrees/${REPO_NAME}-${CLAIM_ID}"
WT_BRANCH="worker/${CLAIM_ID}"
# Fast-forward the project's local `main` to origin/main BEFORE we add the
# per-claim worktree. Pattern 3 follow-up of analysis-1782813826.md: rows
# that claim against a stale local main see a stale parent base for
# `git worktree add -B <branch> ... main` AND for `--local-merged-sha`
# truth-checks. Failure to ff is non-fatal (orphan-claim revive logic still
# resets on the next tick); we just race fewer windows. Crucially, this
# runs BEFORE `worktree add` so even the FIRST claim after a merge observes
# current main. See fast_forward_main() above for the helper contract.
fast_forward_main "$WT_REPO" || true
# Discover the repo's default branch ONCE and reuse at the worktree-add +
# BASELINE_SHA fallback sites. Same helper fast_forward_main uses — keeps
# the three references in lockstep (analysis-1783678328.md Pattern 2 root
# cause: the original three references drifted from each other silently).
WT_DEFAULT="$(default_branch_for_repo "$WT_REPO")"
WT_DEFAULT="${WT_DEFAULT:-main}"
if [ ! -d "$WT_DIR" ]; then
  # -B resets the branch to the default's tip if a stale branch lingers from
  # a prior reaped attempt; --force overrides a leftover claude-agent
  # worktree lock.
  # ponytail: timeout 5s on git worktree add — can hang when nesting worktrees.
  if ! timeout 5 git -C "$WT_REPO" worktree add --force -B "$WT_BRANCH" "$WT_DIR" "$WT_DEFAULT" 2>/dev/null; then
    # Branch may be checked out elsewhere; fall back to a detached worktree so
    # the worker still isolates rather than silently running in prod root.
    # Apply timeout here too to survive nested-worktree hangs.
    timeout 5 git -C "$WT_REPO" worktree add --force --detach "$WT_DIR" "$WT_DEFAULT" 2>/dev/null
  fi
fi
cd "$WT_DIR"
# Baseline HEAD at claim time — reused worktrees from a prior claim may sit
# commits ahead of the default already; reconcile must count only THIS run's
# commits, not everything since the default (else a stale reused worktree
# with 0 new commits masks an empty/failed engine run as reviewable work).
# Fall back to the default branch name when rev-parse fails (empty repo, no
# commits yet) — same `WT_DEFAULT` variable, so the two sites can't drift.
BASELINE_SHA="$(git -C "$WT_DIR" rev-parse HEAD 2>/dev/null || echo "$WT_DEFAULT")"
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

# gate-triage (bin/gate-triage.ts) stamps an opus-chosen minimal tool list into
# the task body; enforce it as --allowedTools on claude engines. Policy is set
# per-task by opus, not by a human. No stamp -> no flag (engine default).
TOOLS_CSV="$(bun "$LEDGER_BIN" show "$CLAIM_ID" "${DB_FLAG[@]}" 2>/dev/null \
  | grep -oE 'allowed-tools: [A-Za-z, ]+' | head -n1 | sed 's/^allowed-tools: //' || true)"
TOOLS_FLAG=()
if [[ -n "$TOOLS_CSV" ]]; then
  IFS=', ' read -r -a _gate_tools <<< "$TOOLS_CSV"
  TOOLS_FLAG=(--allowedTools "${_gate_tools[@]}")
fi

USER_PROMPT="Task ${CLAIM_ID}. You are isolated in worktree ${WT_DIR} (branch
${WT_BRANCH}, off main) — do all work here, never in ${WT_REPO}. Run \`bun ${LEDGER_BIN} ${DB_FLAG[*]} show ${CLAIM_ID}\`
to read it, then execute. On terminal state, ask bookie to update (merged +
evidence + pr, or failed + evidence, or decompose into HITL children). tmux
dies on exit; factory respawns if more work."

# Resolve the failover GROUP for this row's agent→profile→alias chain. `alias-cmd`
# prints one candidate command per line in priority order (G-0006 N-tier
# escalation); we try each in turn and fall over to the next when a candidate
# produces no work. A single-command alias yields a one-element group → original
# behavior.
ALIAS="$(bun "$LEDGER_BIN" resolve-alias "$CLAIM_ID" "${DB_FLAG[@]}")"
mapfile -t CMD_CANDIDATES < <(bun "$LEDGER_BIN" alias-cmd "$ALIAS")
if [[ "${#CMD_CANDIDATES[@]}" -eq 0 ]]; then
  echo "worker-shell: no command candidates for alias '$ALIAS'" >&2
  exit 1
fi

# Engine discriminator (two-tier policy G-0006):
#   - interactive `claude` lives many turns and self-reports its terminal state
#     to the ledger via the bookie subagent. Hand the TTY over with exec — the
#     shell is replaced and the row is the agent's responsibility. An interactive
#     candidate is therefore TERMINAL: there is no failover past it (exec never
#     returns), so it can only be the engine of last resort.
#   - headless `pi -p` / `claude-afk -p` is single-shot: it answers and exits in
#     one process, WITHOUT a bookie round-trip. If we exec it, the session dies
#     with the row still `state='claimed'`, and reapOrphanClaims (factory.ts)
#     resets it to `ready` → respawn loop that burns budget. So for a headless
#     engine we do NOT exec: run it as a CHILD, then a deterministic post-exit
#     reconciler advances the row off `claimed` based on worktree evidence — but
#     only if the agent didn't already advance it (we re-read state first, so a
#     self-reporting agent always wins). No commits + no self-report ⇒ that
#     engine produced nothing (model unavailable / refused / crashed empty) ⇒
#     FALL OVER to the next candidate. These writes reuse the sanctioned
#     bootstrap-exception ledger path (same as the claim and the --branch write
#     above) — pre/post-agent mechanical writes, not in-session writes, so the
#     "all in-session writes via bookie" rule is preserved.
#
# Headless guards (interactive doesn't need them — it execs claude which owns the
# TTY + its own timeout + bookie):
#   (1) Log capture: pane-side `tmux pipe-pane` mirrors the pane to the logfile.
#       `capture_scrollback_to_log` is the last-resort fallback if pipe never
#       attached. Set up once, reused across failover attempts.
#   (2) Stall watchdog: wrap each child in `timeout` so a hung engine self-
#       terminates (SIGTERM at the bound, SIGKILL after 30s -k grace). Expiry
#       exits 124 — a non-zero rc treated like any empty crash (→ failover).
LOG_FILE="$(worker_log_path "$WORKER")"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
STALL_SECS="$(stall_timeout_secs)"
PIPE_READY=0
LAST_RC=0
ATTEMPT=0

for CMD_TEMPLATE in "${CMD_CANDIDATES[@]}"; do
  ATTEMPT=$((ATTEMPT + 1))
  # Split into argv on whitespace, dropping the {prompt} placeholder token. The
  # user turn is passed as a SINGLE positional argv word — never interpolated
  # into a shell-evaluated string (avoids quoting/injection hazards).
  read -ra CMD_PARTS <<< "${CMD_TEMPLATE/\{prompt\}/}"
  # Preserve CLAUDE_BIN override: substitute $CLAUDE for a literal `claude` argv0.
  if [[ "${CMD_PARTS[0]:-}" == "claude" ]]; then
    CMD_PARTS[0]="$CLAUDE"
  fi
  # --allowedTools is claude-specific; other engines would choke on it.
  ENGINE_TOOLS=()
  if [[ "${CMD_PARTS[0]:-}" == "$CLAUDE" ]]; then
    ENGINE_TOOLS=("${TOOLS_FLAG[@]}")
  fi
  # Pre-flight: a candidate whose binary isn't on PATH (engine not installed
  # here) is skipped without running — straight to the next candidate.
  if ! command -v "${CMD_PARTS[0]}" >/dev/null 2>&1; then
    echo "worker-shell: candidate ${ATTEMPT}/${#CMD_CANDIDATES[@]} '${CMD_PARTS[0]}' not on PATH — skipping" >&2
    continue
  fi

  HEADLESS=0
  # cli-agent is headless-by-name (single-shot route() call, never exec()s) —
  # it carries no `-p` flag of its own, so name it explicitly here.
  if [[ "${CMD_PARTS[0]:-}" == "cli-agent" ]]; then
    HEADLESS=1
    # --cwd roots cli-agent in THIS worker's worktree (cli-proxy agent mode).
    # Without it cli-agent used the stateless pool, whose cwd is pinned to an
    # empty sandbox (/var/tmp/cli-proxy-sandbox): tools ran but saw no repo, so
    # every worker exited "produced no work (rc=0)". WT_DIR is under ~/worktrees,
    # cli-proxy's default CLI_PROXY_AGENT_ROOTS allowlist.
    CMD_PARTS+=( --cwd "$WT_DIR" )
  else
    for _arg in "${CMD_PARTS[@]}"; do
      if [[ "$_arg" == "-p" ]]; then HEADLESS=1; break; fi
    done
  fi

  if [[ "$HEADLESS" != "1" ]]; then
    # Interactive engine of last resort — exec hands over the TTY. The pane pipe
    # set at spawn survives the exec and keeps mirroring for the worker's life.
    exec "${CMD_PARTS[@]}" "${ENGINE_TOOLS[@]}" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT"
  fi

  # Headless attempt — run as a child, capture rc, then reconcile-or-failover.
  if [[ "$PIPE_READY" != "1" ]]; then
    setup_pipe_pane "$WORKER" "$LOG_FILE"
    PIPE_READY=1
  fi
  set +e
  timeout -k 30 "$STALL_SECS" "${CMD_PARTS[@]}" "${ENGINE_TOOLS[@]}" --append-system-prompt "$SYS_PROMPT" "$USER_PROMPT" 2>&1
  AGENT_RC=$?
  set -e
  LAST_RC=$AGENT_RC

  # Did the agent already advance the row past the claim? If so, respect it — done.
  POST_STATE="$(json_string_field state "$(bun "$LEDGER_BIN" show "$CLAIM_ID" "${DB_FLAG[@]}" 2>/dev/null || true)")"
  if [[ "$POST_STATE" != "claimed" && "$POST_STATE" != "wip" && -n "$POST_STATE" ]]; then
    capture_scrollback_to_log "$WORKER" "$LOG_FILE"
    exit "$AGENT_RC"
  fi

  # Commits ahead of main = the agent produced work — advance to `review` even on
  # a non-zero exit (a crash after committing real work is salvageable) and stop
  # the failover chain. reconcile_decision (the unit-tested helper) returns
  # "review" iff there are commits; "failed" (no commits) means fall over.
  COMMITS_AHEAD="$(git -C "$WT_DIR" rev-list --count "${BASELINE_SHA}..HEAD" 2>/dev/null || echo 0)"
  if [[ "$(reconcile_decision "$AGENT_RC" "$COMMITS_AHEAD")" == "review" ]]; then
    HEAD_SHA="$(git -C "$WT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    HEAD_FULL="$(git -C "$WT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    # A crashed headless worker may have already filed a PR before exiting.
    # Discover it (best-effort) so recovery doesn't re-file. `gh` absent/
    # unauthed/no-PR all collapse to empty → pr_url null in the payload.
    DISCOVERED_PR="$(gh pr view "$WT_BRANCH" --json url -q .url 2>/dev/null || true)"
    EVIDENCE="headless reconcile: candidate ${ATTEMPT}/${#CMD_CANDIDATES[@]} (${CMD_PARTS[0]}) exited ${AGENT_RC} with ${COMMITS_AHEAD} commit(s) on ${WT_BRANCH} (HEAD ${HEAD_SHA}) but did not self-report; advanced to review (commits salvageable regardless of exit code)."
    bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --state review --evidence "$EVIDENCE" >/dev/null 2>&1 || true
    # Structured handoff for the recovery worker/gate (Pattern 1, analysis-1783935600).
    # ponytail: base/head/branch/pr_url escaped via jq --arg, safe for any content.
    SALVAGE_JSON="$(salvage_payload_json "$BASELINE_SHA" "$HEAD_FULL" "$COMMITS_AHEAD" "$WT_BRANCH" "$AGENT_RC" "$DISCOVERED_PR")"
    bun "$LEDGER_BIN" event "$CLAIM_ID" note "$SALVAGE_JSON" "${DB_FLAG[@]}" --agent "$WORKER" >/dev/null 2>&1 || true
    capture_scrollback_to_log "$WORKER" "$LOG_FILE"
    exit "$AGENT_RC"
  fi

  # No self-report, no commits → this engine produced nothing. Fall over.
  echo "worker-shell: candidate ${ATTEMPT}/${#CMD_CANDIDATES[@]} (${CMD_PARTS[0]}) produced no work (rc=${AGENT_RC}); trying next" >&2
done

# Every candidate exhausted with no commits and no self-report → this is an
# engine-infrastructure outage, not a task defect (e.g. MiniMax billing lapse
# starving every candidate for this alias). Mark `blocked` with a
# machine-readable reason so the auto-recovery sweep can flip it back to
# `ready` once the alias produces work again — `failed` stays reserved for
# task-attributable errors.
EVIDENCE="headless reconcile: all ${#CMD_CANDIDATES[@]} candidate engine(s) for alias '${ALIAS}' produced no work (last rc=${LAST_RC}); engine-alias-no-work:${ALIAS}"
bun "$LEDGER_BIN" update "$CLAIM_ID" "${DB_FLAG[@]}" --state blocked --evidence "$EVIDENCE" >/dev/null 2>&1 || true
capture_scrollback_to_log "$WORKER" "$LOG_FILE"
exit "$LAST_RC"
