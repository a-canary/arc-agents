#!/usr/bin/env bash
# search.sh — KE (knowledge engine) integration demo for arc-agents.
#
# Demonstrates: ke-recall + ke-learn skills using the ke installation.
# Prerequisites:
#   - ke repo at ~/repos/ke (or set KE_REPO env var)
#   - KE compiled: bun ~/repos/ke/bin/ke-tool.ts compile
#
# This script is safe to run — it only searches/reads from the KE vault
# and prints results. It does not modify any arc-agents state.

set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERR ]${NC} $1"; }

KE_REPO="${KE_REPO:-$HOME/repos/ke}"
KE_TOOL="$KE_REPO/bin/ke-tool.ts"
VAULT_KE="${KE_ROOT:-$HOME/vault/ke}"

# ── Dependency check ─────────────────────────────────────────────────────────
check_dependencies() {
  local missing=0

  if ! command -v bun &>/dev/null; then
    err "bun not found — install from https://bun.sh"
    ((missing++))
  fi

  if [[ ! -f "$KE_TOOL" ]]; then
    warn "ke repo not found at $KE_REPO"
    echo "  Clone it: git clone git@github.com:a-canary/ke.git $KE_REPO"
    echo "  Then: cd $KE_REPO && bun install && bun $KE_TOOL compile"
    echo ""
    echo "Skipping KE search demo."
    return 1
  fi

  return 0
}

# ── Run search queries ────────────────────────────────────────────────────────
run_queries() {
  info "Running KE search queries..."

  local queries=(
    "agent architecture ledger"
    "ephemeral workers"
    "knowledge engine research"
  )

  for q in "${queries[@]}"; do
    echo ""
    echo -e "${YELLOW}--- ke search \"$q\" ---${NC}"
    KE_ROOT="$VAULT_KE" bun "$KE_TOOL" search "$q" --limit 3 2>&1 || echo "(no results or error)"
  done
}

# ── Show KE skill files ───────────────────────────────────────────────────────
show_skills() {
  info "KE skills shipped with arc-agents:"
  for skill in ke-learn ke-recall; do
    local path="$WORKSPACE/skills/$skill/SKILL.md"
    if [[ -f "$path" ]]; then
      echo "  ✓ skills/$skill/SKILL.md"
      local lines=$(wc -l < "$path")
      echo "    $lines lines — delegates to $KE_REPO/bin/ke-tool.ts"
    else
      echo "  ✗ skills/$skill/SKILL.md missing"
    fi
  done
}

# ── Main ─────────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  arc-agents — KE Integration Demo"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if ! check_dependencies; then
  echo ""
  ok "arc-agents is intact — KE demo skipped (no ke repo)"
  echo "Install ke to enable the search demo."
  exit 0
fi

ok "ke repo found: $KE_REPO"

show_skills
run_queries

echo ""
ok "KE search demo complete"
echo ""
echo "How arc-agents uses KE:"
echo "  • ke-recall  — auto-runs at session boot (S-0001)"
echo "  • ke-learn   — auto-runs at session stop (S-0001)"
echo "  • Both delegate to: $KE_TOOL"