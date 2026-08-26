#!/usr/bin/env bash
# tick.sh — Simulate a worker claiming and advancing a task through the ledger.
#
# Uses a temp DB so no production data is touched. Walks through the
# full lifecycle: ready → claimed → wip → review → merged.
#
# Prerequisites:
#   bun install   # in the arc-agents repo root

set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$WORKSPACE/bin/ledger.ts"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

TEMP_DB="/tmp/arc-examples-tick-$$-$(date +%s).db"
WORKER="demo-worker-$$"

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $1"; }
err()   { echo -e "${RED}[ERR ]${NC} $1"; }

cleanup() {
  if [[ -f "$TEMP_DB" ]]; then
    rm -f "$TEMP_DB"
    info "Removed temp DB"
  fi
}
trap cleanup EXIT

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  arc-agents — Worker Lifecycle Demo"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Init + create ─────────────────────────────────────────────────────────────
info "1. Initialize ledger + create a ready issue"
"$LEDGER" init --db "$TEMP_DB" > /dev/null

RESULT=$("$LEDGER" create --db "$TEMP_DB" \
  --title "demo: worker lifecycle walkthrough" \
  --kind task \
  --type quality \
  --pool explore 2>&1)

ISSUE_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

if [[ -z "$ISSUE_ID" ]]; then
  err "failed to create issue"
  exit 1
fi

echo "  id: $ISSUE_ID"
echo "  state: ready"
ok "issue created"
echo ""

# ── Claim ──────────────────────────────────────────────────────────────────────
info "2. Worker claims the issue"
"$LEDGER" claim "$WORKER" --db "$TEMP_DB" > /dev/null 2>&1
STATE=$("$LEDGER" show "$ISSUE_ID" --db "$TEMP_DB" 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin)['issue']['state'])" 2>/dev/null)
echo "  state: $STATE"
echo "  claimed_by: $WORKER"
ok "issue claimed (state=wip)"
echo ""

# ── Event: work in progress ───────────────────────────────────────────────────
info "3. Worker appends a progress event"
"$LEDGER" event "$ISSUE_ID" note "Working on the demo..." --db "$TEMP_DB" 2>&1 | head -1
ok "event appended"
echo ""

# ── Update to review ───────────────────────────────────────────────────────────
info "4. Worker advances to review"
"$LEDGER" update "$ISSUE_ID" --state review --db "$TEMP_DB" > /dev/null 2>&1
STATE=$("$LEDGER" show "$ISSUE_ID" --db "$TEMP_DB" 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin)['issue']['state'])" 2>/dev/null)
echo "  state: $STATE"
ok "state updated: wip → review"
echo ""

# ── Update to merged ──────────────────────────────────────────────────────────
info "5. Issue merges (diff_review event required per G-0002)"
# ledger.ts refuses merged without a diff_review event (G-0002 enforcement)
# The real workflow: worker runs /diff-review skill, then logs the event.
# For the demo, add the event directly so we can show the terminal state.
# Payload must satisfy the G-0002 contract: reviewer_identity (≠ claimed_by),
# reviewed_sha (7–40 hex), verdict (pass|fail|comment).
"$LEDGER" event "$ISSUE_ID" diff_review '{"reviewer_identity":"demo-reviewer-subagent","reviewed_sha":"deadbeef","verdict":"pass"}' --db "$TEMP_DB" > /dev/null 2>&1
# Temp-DB demo: no GitHub PR, so acknowledge in-place with evidence.
MERGE_OUT=$("$LEDGER" update "$ISSUE_ID" --state merged --in-place \
  --evidence "demo run: temp-DB lifecycle walkthrough" --db "$TEMP_DB" 2>&1)
STATE=$("$LEDGER" show "$ISSUE_ID" --db "$TEMP_DB" 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin)['issue']['state'])" 2>/dev/null)
echo "  state: $STATE"
if [[ "$STATE" == "merged" ]]; then
  ok "state updated: review → merged (terminal)"
else
  ok "diff_review gate active — state is $STATE (in production: run /diff-review skill first)"
fi
echo ""

# ── Show final history ─────────────────────────────────────────────────────────
info "6. Final issue + event history"
"$LEDGER" show "$ISSUE_ID" --db "$TEMP_DB" 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('  state:', d['issue']['state'])
print('  events:', len(d['events']))
for e in d['events'][:6]:
    print(f'    [{e[\"seq\"]}] {e[\"kind\"]} — {e[\"agent\"]}')
" 2>/dev/null || "$LEDGER" show "$ISSUE_ID" --db "$TEMP_DB" 2>&1 | head -15

echo ""
ok "Lifecycle demo complete"
echo ""
echo "What you saw:"
echo "  ready   — issue created, waiting for a worker"
echo "  claimed — worker atomically took the issue (single UPDATE...RETURNING)"
echo "  wip     — worker is actively doing the task"
echo "  review  — work submitted for review"
echo "  merged  — accepted, terminal. Blocked children are now unblocked."
echo ""
echo "The atomic claim uses G-0002 (one SQL UPDATE...RETURNING, no locks)."