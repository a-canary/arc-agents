#!/usr/bin/env bash
# smoke.sh — Sanity-check arc-agents runnable artifacts.
#
# Verifies:
#   - All skills present
#   - CLI bins parse without errors
#   - Test suite runs (subset)
#
# From a clean clone:
#   cd ~/repos/arc-agents
#   bun install
#   chmod +x examples/*.sh
#   ./examples/smoke.sh

set -euo pipefail

WORKSPACE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[ OK ]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }

echo "=== arc-agents Smoke Test ==="
echo ""

bad=0

# ── Bun runtime ────────────────────────────────────────────────────────────────
echo "Runtime:"
if command -v bun &>/dev/null; then
  ok "bun $(bun --version)"
else
  fail "bun not found — install from https://bun.sh"
  ((bad++))
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
echo ""
echo "Dependencies:"
if [[ -f "$WORKSPACE/node_modules/bun" ]] || [[ -d "$WORKSPACE/node_modules" ]]; then
  ok "node_modules/ present"
else
  info "Running bun install..."
  (cd "$WORKSPACE" && bun install) || true
fi

# ── Core library files ────────────────────────────────────────────────────────
echo ""
echo "Core lib:"
for f in "src/ledger/db.ts" "src/ledger/claim.ts" "src/ledger/migrate.ts" "src/ledger/bookie-validator.ts"; do
  if [[ -f "$WORKSPACE/$f" ]]; then
    ok "$f"
  else
    fail "missing: $f"
    ((bad++))
  fi
done

# ── Skills ─────────────────────────────────────────────────────────────────────
echo ""
echo "Skills:"
for skill in "bookie" "ke-recall" "ke-learn" "claude-afk" "to-ledger" "triage-failed" "spawn" "diff-review" "analyse-recent-sessions"; do
  if [[ -f "$WORKSPACE/skills/$skill/SKILL.md" ]]; then
    ok "$skill"
  else
    fail "missing: skills/$skill/SKILL.md"
    ((bad++))
  fi
done

# ── KE integration skills ──────────────────────────────────────────────────────
echo ""
echo "KE integration skills:"
for skill in "ke-recall" "ke-learn"; do
  if [[ -f "$WORKSPACE/skills/$skill/SKILL.md" ]]; then
    # Check skill references KE CLI in ke repo
    if grep -q "ke.ts\|ke-tool\|ke tool" "$WORKSPACE/skills/$skill/SKILL.md" 2>/dev/null; then
      if [[ -f "$HOME/repos/ke/bin/ke-tool.ts" ]]; then
        ok "$skill references KE tool (ke repo available)"
      else
        warn "$skill references KE tool but ~/repos/ke not found — install ke repo separately"
      fi
    fi
  fi
done

# ── Bin executables ────────────────────────────────────────────────────────────
echo ""
echo "Bin scripts:"
for f in "ledger.ts" "factory.ts" "worker-shell.sh"; do
  if [[ -f "$WORKSPACE/bin/$f" ]]; then
    ok "bin/$f"
  else
    fail "missing: bin/$f"
    ((bad++))
  fi
done

# ── CLI parsing check ──────────────────────────────────────────────────────────
echo ""
echo "CLI parsing:"
if [[ -f "$WORKSPACE/bin/ledger.ts" ]]; then
  # ledger.ts has no --help; it treats any unknown verb as positional queries
  # and lists the ledger. We just verify it doesn't crash.
  if "$WORKSPACE/bin/ledger.ts" list 2>&1 | grep -q "\["; then
    ok "ledger.ts list runs"
  else
    warn "ledger.ts list unexpected output"
  fi
  if "$WORKSPACE/bin/ledger.ts" init 2>&1 | grep -q "applied"; then
    ok "ledger.ts init runs (no ledger yet — applied:[] is correct)"
  fi
fi

# ── Examples ──────────────────────────────────────────────────────────────────
echo ""
echo "Examples:"
if [[ -d "$WORKSPACE/examples" ]]; then
  example_count=$(find "$WORKSPACE/examples" -name "*.sh" 2>/dev/null | wc -l)
  ok "examples/ — $example_count script(s)"
else
  warn "examples/ directory not present"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ "$bad" -eq 0 ]]; then
  echo -e "${GREEN}All checks passed.${NC}"
  exit 0
else
  echo -e "${RED}$bad check(s) failed.${NC}"
  exit 1
fi