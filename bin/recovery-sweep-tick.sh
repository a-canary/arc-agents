#!/usr/bin/env bash
# recovery-sweep-tick.sh — periodic lane-4 drainer: flip engine-outage-blocked
# rows back to `ready` once their alias is producing work again.
#
# Driver: `bin/recovery-sweep.ts` (sweep MVP slice, src/ledger/recovery-sweep.ts).
# It walks every `state=blocked` row whose evidence carries the marker
# `engine-alias-no-work:<alias>`, groups by alias, runs ONE trivial probe per
# distinct alias, and — iff the probe returns rc=0 with non-empty stdout —
# flips every row for that alias back to `ready` with an audit event.
# Alias still starved → rows stay `blocked`, no state change, retry next tick.
#
# This shell wrapper is just the cron-side glue: PATH + flock + exec. Same
# shape as feedback-tick.sh. Probes per tick are bounded (one per distinct
# alias), so a 5-minute cadence is cheap; recovery is bounded by cadence.
#
# Cron (every 5 min, install via crontab -e):
#   */5 * * * * /home/aaron/repos/arc-agents/bin/recovery-sweep-tick.sh >> /home/aaron/.cache/arc-recovery-sweep-tick.log 2>&1
#
# Manual run (operator force-recover after a known outage resolution):
#   /home/aaron/repos/arc-agents/bin/recovery-sweep-tick.sh
# or, to bypass the flock and run the sweep module directly:
#   /home/aaron/.bun/bin/bun /home/aaron/repos/arc-agents/bin/recovery-sweep.ts [path-to-ledger.db]
#
# Exit codes: 0 on clean run (incl. no-op when no rows carry the marker);
# non-zero if the sweep module throws.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="${BUN:-/home/aaron/.bun/bin/bun}"
# cron's PATH (/usr/bin:/bin) resolves neither `pi` (lives in node's bin dir,
# no /usr/local/bin symlink) nor `cli-agent` (~/.local/bin). The sweep spawns
# `bash -c "<alias cmd>"` for its probe, so the alias command must resolve —
# without this every probe dies rc=127 (command not found) and rows never
# recover. Prepend the real locations; keep the inherited PATH as tail.
export PATH="$HOME/.local/bin:/usr/local/lib/node_modules/node/bin:/usr/local/bin:$PATH"
SWEEP="$REPO/bin/recovery-sweep.ts"
LOCK=/tmp/arc-recovery-sweep-tick.lock

if [ ! -f "$SWEEP" ]; then
  # Forward reference: the sweep MVP slice ships bin/recovery-sweep.ts.
  # Until it lands, the tick is a quiet no-op (don't flap the log).
  exit 0
fi

# flock -n: one sweep at a time. A sweep that hits a slow probe exits cleanly;
# if a tick is still going when the next fires, the new one exits immediately
# rather than stacking a 2nd probe fleet.
exec flock -n "$LOCK" "$BUN" "$SWEEP"
