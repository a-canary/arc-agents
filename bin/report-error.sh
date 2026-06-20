#!/usr/bin/env bash
# report-error.sh — route an error/warning to the LEDGER (system of record).
#
# The ledger (~/vault/ledger.db) is the only message bus in arc-agents — there
# is no file inbox. This emits a `note` event row (severity in the payload)
# keyed to the current task/issue, and always appends a durable audit line to
# errors.log.
#
# Usage:
#   report-error.sh [--issue <id>] [--severity error|warn|info] \
#                   [--source <component>] [--context <file>] \
#                   <one-line summary>
#
# Defaults:
#   --issue   $ARC_TASK_ID or $ARC_ISSUE_ID (the worker's claimed task)
#   --severity error
#   --source  the calling script (BASH_SOURCE[1])
#
# Examples:
#   report-error.sh "cycle-reset could not find claude CLI"
#   report-error.sh --severity warn --source "hook:session-end" \
#                   "SessionEnd hook failed; CLAUDE_PLUGIN_ROOT not expanded"
#   report-error.sh --source tests/run.sh --context "$LOG" "smoketest failed"
#
# Exit 0 on successful route (ledger emit is best-effort; the errors.log line
# is the durable guarantee). Exit 1 only on usage error (missing summary).
set -euo pipefail

export PATH="${HOME}/.local/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ISSUE="${ARC_TASK_ID:-${ARC_ISSUE_ID:-}}"
SEVERITY="error"
SOURCE=""
CONTEXT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) ISSUE="$2"; shift 2 ;;
    --severity) SEVERITY="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --to) shift 2 ;;  # accepted+ignored for backward compat (no agent inboxes)
    --) shift; break ;;
    *) break ;;
  esac
done

SUMMARY="${*:-}"
[[ -n "$SUMMARY" ]] || { echo "report-error: missing summary" >&2; exit 1; }

case "$SEVERITY" in error|warn|info) ;; *) SEVERITY="error" ;; esac

[[ -n "$SOURCE" ]] || SOURCE="${BASH_SOURCE[1]:-unknown}"

VAULT="${VAULT_DIR:-$HOME/vault}"
LOG="$VAULT/observations/errors.log"
mkdir -p "$(dirname "$LOG")"

now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# Durable audit line — single-line, machine-parseable.
# ts | severity | issue | source | summary (tab-separated; newlines escaped)
printf '%s\t%s\t%s\t%s\t%s\n' \
  "$now" "$SEVERITY" "${ISSUE:-none}" "$SOURCE" "${SUMMARY//$'\n'/\\n}" >> "$LOG"

# Emit to the ledger. The `event` verb appends an issue_events row; we key it to
# the worker's task (ARC_TASK_ID) just like hooks/session-end.sh does. The
# issue_events.kind CHECK has no 'error' member — infra errors ride the generic
# 'note' kind, with severity carried in the JSON payload. Without a task id there
# is nothing to attach the event to — the durable errors.log line above is the
# fallback of record. No file inbox, no agent-system routing.
if [[ -n "$ISSUE" ]] && command -v bun >/dev/null 2>&1; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  payload="$(SEV="$SEVERITY" SRC="$SOURCE" SUM="$SUMMARY" CTX="$CONTEXT" \
    bun -e 'process.stdout.write(JSON.stringify({type:"report-error",severity:process.env.SEV,source:process.env.SRC,summary:process.env.SUM,context:process.env.CTX||undefined}))' \
    2>/dev/null || printf '{"type":"report-error","severity":"%s","source":"%s"}' "$SEVERITY" "$SOURCE")"
  bun "$REPO/bin/ledger.ts" event "$ISSUE" note "$payload" --agent report-error >/dev/null 2>&1 || {
    echo "report-error: ledger emit failed for $ISSUE; durable line saved to errors.log" >&2
  }
else
  [[ -n "$ISSUE" ]] || echo "report-error: no ARC_TASK_ID/ARC_ISSUE_ID; saved to errors.log only" >&2
fi

exit 0
