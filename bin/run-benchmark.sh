#!/usr/bin/env bash
# Run O-0008 benchmark scripts with API keys and model/URL patching.
#
# Reads ~/repos/conjecture/.conjecture/config.json for credentials.
# Patches:
#   - api.chutes.ai → llm.chutes.ai (correct endpoint)
#   - deepseek-ai/DeepSeek-V3 → deepseek-ai/DeepSeek-V3.2-TEE (available model)
#
# Usage:
#   ./run-benchmark.sh drop_benchmark.py -n 20
#   ./run-benchmark.sh math_benchmark.py -n 20
#   ./run-benchmark.sh humaneval_benchmark.py -n 20

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONJECTURE_DIR="$HOME/repos/conjecture"

# Load API keys from conjecture config
source <(python3 "$SCRIPT_DIR/export-keys.sh")

# Default model patch
export BENCHMARK_MODEL="${BENCHMARK_MODEL:-deepseek-ai/DeepSeek-V3.2-TEE}"

BENCHMARK_SCRIPT="$1"
shift

if [ -z "$CHUTES_API_KEY" ]; then
    echo "ERROR: CHUTES_API_KEY not available from config" >&2
    exit 1
fi

SCRIPT_PATH="$CONJECTURE_DIR/experiments/$BENCHMARK_SCRIPT"
if [ ! -f "$SCRIPT_PATH" ]; then
    echo "ERROR: Benchmark script not found: $SCRIPT_PATH" >&2
    exit 1
fi

cd "$CONJECTURE_DIR"
exec python3 "$SCRIPT_PATH" "$@"