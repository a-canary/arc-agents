#!/usr/bin/env bash
# Secret guard: block commit if staged changes contain a likely secret.
# Fast path only — scans the staged diff with gitleaks, not full history
# (full-history scan is bin/secret-scan-gate.sh, run at release time).
#
# Exit 0 = clean/skip. Exit 1 = secret found, commit blocked.
#
# Bypass: SECRET_GUARD_SKIP=1 git commit ...

set -euo pipefail

if [[ "${SECRET_GUARD_SKIP:-0}" == "1" ]]; then
  exit 0
fi

REPO="$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "secret-guard: gitleaks not found on PATH — skipping (install: sudo apt install gitleaks)" >&2
  exit 0
fi

# No --config: uses gitleaks' built-in default ruleset. A repo-local
# .gitleaks.toml here typically only carries an [allowlist] block (see
# .gitleaks.toml's own comment), and passing it as --config replaces the
# default rules with nothing rather than extending them.
if ! gitleaks protect --staged --source "$REPO" --redact; then
  echo "secret-guard: BLOCKED — gitleaks found a likely secret in the staged diff." >&2
  echo "  bypass with SECRET_GUARD_SKIP=1 git commit ..." >&2
  exit 1
fi

exit 0
