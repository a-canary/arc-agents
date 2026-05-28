#!/usr/bin/env bash
# secret-scan-gate.sh — blocks release on real secret findings
# Exit 0 = no secrets found (pass)
# Exit 1 = secrets found (fail/block)
# Exit 2 = scanner not installed (fail-closed)
#
# gitleaks  — fast pattern/regex scan against git history + working tree
# trufflehog — entropy + verified-secret scan (deep, slower)
#
# Both must pass for the gate to clear. gitleaks fail-closes if missing;
# trufflehog SKIPs if missing (it's the deep-check, not the fast gate).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

# PATH must include ~/bin for user-installed trufflehog
export PATH="$HOME/bin:$PATH"

# ── gitleaks: fast pattern scan ────────────────────────────────────────────

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[secret-scan] ERROR: gitleaks not found. Install: sudo apt install gitleaks" >&2
  echo "[secret-scan] Cannot proceed without gitleaks — failing closed." >&2
  exit 2
fi

cd "$PROJECT"
echo "[secret-scan] Running gitleaks (pattern/regex scan)..."
if ! gitleaks detect --source . --config "$SCRIPT_DIR/../.gitleaks.toml" --redact; then
  echo "[secret-scan] FAIL: gitleaks detected secrets." >&2
  exit 1
fi
echo "[secret-scan] gitleaks: clean"

# ── trufflehog: entropy + verified-secret scan ─────────────────────────────

if command -v trufflehog >/dev/null 2>&1; then
  echo "[secret-scan] Running trufflehog (entropy + verified-secret scan)..."
  if trufflehog filesystem "$PROJECT" --no-update >/tmp/trufflehog-$$.log 2>&1; then
    echo "[secret-scan] trufflehog: clean"
  else
    # trufflehog exits 0 when no secrets found, non-zero when secrets found
    echo "[secret-scan] FAIL: trufflehog detected secrets." >&2
    cat /tmp/trufflehog-$$.log >&2
    exit 1
  fi
else
  echo "[secret-scan] SKIP: trufflehog not installed (not on PATH or not in ~/bin)"
fi

echo "[secret-scan] All secret scans passed."