#!/usr/bin/env bash
# Periodic Lane-2 drainer: turn stagnant OPEN feedback into PRDs.
#
# Walks every project with OPEN feedback; per project the aggregator's trigger
# gate (>=1 trusted row OR >5 untrusted rows) decides whether to spend a planner
# pass. Below the gate it's a cheap no-op, so running this often is fine.
#
# flock -n is the "one planner at a time" guarantee: a planner pass shells out to
# the (synchronous) plan-agent and can run minutes; if a tick is still going when
# the next fires, the new one exits immediately rather than stacking a 2nd planner.
#
# Cron (every 5 min):
#   */5 * * * * /home/aaron/repos/arc-agents/bin/feedback-tick.sh >> /home/aaron/.cache/arc-feedback-tick.log 2>&1
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="${BUN:-/home/aaron/.bun/bin/bun}"
exec flock -n /tmp/arc-feedback-tick.lock "$BUN" "$REPO/bin/feedback-aggregate.ts" --all-projects
