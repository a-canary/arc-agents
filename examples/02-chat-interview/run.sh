#!/usr/bin/env bash
# examples/02-chat-interview/run.sh
# ─────────────────────────────────────────────────────────────────
# Chat/interview quickstart — post a message, stream the reply.
# Prerequisites: bun, a running arc-factory (ledger must be reachable)
# (run examples/01-ledger-quickstart/run.sh first to start the factory,
#  or `bun bin/factory.ts` in a separate terminal)
#
# Usage:
#   bash examples/02-chat-interview/run.sh "How do I create a new task?"
#
# No private paths, no proprietary keys.
set -euo pipefail

LEDGER="${LEDGER:-./bin/ledger.ts}"
CHAT="${CHAT:-./bin/arc-chat.ts}"
MESSAGE="${1:-Hello, what can arc-agents do?}"

echo "=== Chat interview quickstart ==="
echo

# ── 1. Post a message ───────────────────────────────────────────────────────
echo "[1/4] post message: $MESSAGE"
RESULT=$(bun "$CHAT" post "$MESSAGE")
echo "$RESULT"

# parse JSON using bun (consistent with runtime, no external deps)
TMP=$(mktemp)
echo "$RESULT" > "$TMP"
THREAD=$(node -e "
  const fs = require('fs');
  const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(d.thread_id || '');
" "$TMP")
rm -f "$TMP"

if [ -z "$THREAD" ]; then
  echo "  (could not parse thread_id — skipping tail)"
  THREAD=""
fi

# ── 2. Show thread list ─────────────────────────────────────────────────────
echo
echo "[2/4] recent threads"
timeout 3 bun "$CHAT" threads --limit 3 || true

# ── 3. Tail replies (blocking) ──────────────────────────────────────────────
echo
if [ -n "$THREAD" ]; then
  echo "[3/4] stream replies for thread $THREAD"
  echo "  (waiting for interviewer reply...)"
  timeout 30 bun "$CHAT" tail --thread "$THREAD" --once || true
else
  echo "[3/4] stream replies (skipped — no thread id)"
fi

# ── 4. Show recent issues ───────────────────────────────────────────────────
echo
echo "[4/4] recent ready issues"
bun "$LEDGER" list --state ready | tail -10 || true

echo
echo "=== Done ==="
