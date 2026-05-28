#!/usr/bin/env bash
# secret-scan-gate.sh — blocks release on real secret findings
# Exit 0 = no secrets found (pass)
# Exit 1 = secrets found (fail/block)
# Exit 2 = gitleaks not installed (fail-closed)

set -euo pipefail

if ! command -v gitleaks &>/dev/null; then
  echo "[secret-scan] ERROR: gitleaks not found. Install: brew install gitleaks" >&2
  echo "[secret-scan] Cannot proceed without scanner — failing closed." >&2
  exit 2
fi

cd "$(dirname "$0")/.."

echo "[secret-scan] Running gitleaks against full repo history..."
gitleaks detect --source . --config "$(dirname "$0")/../.gitleaks.toml"
