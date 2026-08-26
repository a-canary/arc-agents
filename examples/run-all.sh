#!/usr/bin/env bash
# run-all.sh — Run all arc-agents public examples.
# From a clean clone:
#   cd ~/repos/arc-agents
#   bun install
#   chmod +x examples/*.sh
#   ./examples/run-all.sh

set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  arc-agents — Public Examples"
echo "  workspace: $WORKSPACE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Make scripts executable (idempotent)
chmod +x "$WORKSPACE/examples/smoke.sh"     2>/dev/null || true
chmod +x "$WORKSPACE/examples/ledger.sh"    2>/dev/null || true
chmod +x "$WORKSPACE/examples/tick.sh"     2>/dev/null || true
chmod +x "$WORKSPACE/examples/search.sh"   2>/dev/null || true
chmod +x "$WORKSPACE/examples/commands.sh" 2>/dev/null || true

# 1. Smoke test — no services needed
echo ""
echo "━━━ 1/5: Smoke test ━━━━━━━━━━━━━━━━━━━━━━━"
"$WORKSPACE/examples/smoke.sh"

# 2. Ledger demo — isolated temp DB, no services needed
echo ""
echo "━━━ 2/5: Ledger CLI demo ━━━━━━━━━━━━━━━━━━"
"$WORKSPACE/examples/ledger.sh"

# 3. Worker lifecycle — walk through ready→claimed→wip→review→merged
echo ""
echo "━━━ 3/5: Worker lifecycle demo ━━━━━━━━━━━━━"
"$WORKSPACE/examples/tick.sh"

# 4. Commands overview — reads skill files only
echo ""
echo "━━━ 4/5: CLI verb reference ━━━━━━━━━━━━━━━━"
"$WORKSPACE/examples/commands.sh"

# 5. KE search demo — needs ke repo (no external services)
echo ""
echo "━━━ 5/5: KE search demo ━━━━━━━━━━━━━━━━━━━━"
"$WORKSPACE/examples/search.sh" || echo "(KE search demo skipped — needs ke repo)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ All examples ran"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "  bun $WORKSPACE/bin/factory.ts        # start worker supervisor"
echo "  bun $WORKSPACE/bin/ledger.ts tick    # claim + dispatch ready issues"