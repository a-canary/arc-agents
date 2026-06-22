#!/usr/bin/env bash
# program-bench 10-min poller — GATED, do not install until the metric is proven
# to move across >=2 commits (see README "Scaling").
#
# Queues a benchmark run only when HEAD changed since the last recorded run, so
# the 10-min tick is a no-op in the (common) idle window. MiniMax-only; the
# harness self-guards against any Anthropic alias.
#
# Install (when ready), e.g. crontab:
#   */10 * * * * /home/aaron/repos/arc-agents/program-bench/cron.sh >> /tmp/program-bench.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."   # arc-agents repo root

git fetch --quiet origin main || true
HEAD_SHA=$(git rev-parse --short=8 HEAD)
LAST=$(tail -n1 program-bench/results.jsonl 2>/dev/null | grep -o '"sha":"[^"]*"' | cut -d'"' -f4 || true)

if [ "$HEAD_SHA" = "$LAST" ]; then
  echo "program-bench: HEAD $HEAD_SHA already benchmarked, skip"
  exit 0
fi
echo "program-bench: new commit $HEAD_SHA (last=$LAST), running"
bun program-bench/run.ts --sha "$HEAD_SHA" --feedback
