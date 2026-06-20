#!/usr/bin/env bash
# cron-preamble.sh — sourced at the top of every cron script.
#
# Sets a sane PATH (cron strips it) and installs an ERR trap that routes
# any uncaught failure to the LEDGER via report-error.sh. Script line
# number + last command + exit code land in the error event; the calling
# script doesn't need to add any error handling.
#
# Usage in a cron script:
#   #!/usr/bin/env bash
#   . "$(dirname "$0")/cron-preamble.sh"   # co-located in arc-agents/bin
#   set -euo pipefail
#   ... rest of script ...
#
# Opt out of the trap for a section (e.g., a noisy optional step):
#   trap - ERR
#   ...
#   trap '_cron_err' ERR

export PATH="${HOME}/.local/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# Optional dropin for host-local env (alternate vault path, etc.).
# File is KEY=value lines; unset vars are fine.
if [ -f "${HOME}/.config/arc-agents/env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${HOME}/.config/arc-agents/env"
  set +a
fi

# report-error.sh is co-located in this bin/ — resolve relative to this file,
# not the retired ~/projects/agent-system path.
_CRON_REPORT_ERROR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/report-error.sh"

_cron_err() {
  local rc=$?
  local script
  script="$(basename "${BASH_SOURCE[1]:-${0:-unknown}}")"
  local line="${BASH_LINENO[0]:-?}"
  local cmd="${BASH_COMMAND:-?}"
  # Best-effort: don't let the trap itself fail the pipe.
  [[ -x "$_CRON_REPORT_ERROR" ]] || return 0
  "$_CRON_REPORT_ERROR" \
    --severity error \
    --source "cron:$script" \
    "exit $rc at line $line: \`$cmd\`" \
    >/dev/null 2>&1 || true
}
trap '_cron_err' ERR
