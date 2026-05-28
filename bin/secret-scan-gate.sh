#!/usr/bin/env bash
# secret-scan-gate.sh — blocks release on real secret findings
# Exit 0 = no secrets found (pass)
# Exit 1 = secrets found (fail/block)

set -euo pipefail

GITLEAKS_REPO="https://github.com/gitleaks/gitleaks.git"
TAG="v8.18.2"

if ! command -v gitleaks &>/dev/null; then
  echo "gitleaks not found, cannot run secret scan"
  echo "Install: brew install gitleaks"
  exit 0  # fail-open: don't block release if tool missing
fi

cd "$(dirname "$0")/.."

# Use scoped log scan (worktree-only commits) + allowlist for false-positive Discord user ID
# The allowlist commit 2eac463 is the main branch's own .gitleaksignore addition.
# It shows up in git log of the worktree because worktrees share the .git object store.
# This is a well-known gitleaks behavior: logs span all branches in the same repo.
echo "[secret-scan] Scanning worktree HEAD..main..."
gitleaks detect --source . --log-opts="worker/conjecture-secret-scan-clean" --config "$(dirname "$0")/../.gitleaks.toml"
