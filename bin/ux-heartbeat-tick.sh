#!/usr/bin/env bash
# ux-heartbeat-tick — keep the arc-tui UX module alive in ux_heartbeats.
#
# Why cron and not bin/arc-tui-loop.sh: that loop is a foreground render loop
# tied to a terminal, so it dies with the session — which is exactly how the
# HITL surface went dark for ~82 days (every `hitl emit` failed the liveness
# gate). Cron restarts unattended and survives reboot.
#
# STALE_SEC is 300 (src/ledger/ux-config.ts), so a 1-minute tick leaves 5x margin.
. "$(dirname "$0")/cron-preamble.sh"
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bun "$REPO/bin/arc-tui.ts" heartbeat
