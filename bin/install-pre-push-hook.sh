#!/usr/bin/env bash
# install-pre-push-hook.sh — install the pre-push secret scan hook
#
# Copies bin/pre-push-hook to .git/hooks/pre-push (executable).
# Safe to run multiple times; always overwrites with latest version.
#
# Run once per clone: bin/install-pre-push-hook.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_DEST="$PROJECT/.git/hooks/pre-push"

mkdir -p "$PROJECT/.git/hooks"
cp "$SCRIPT_DIR/pre-push-hook" "$HOOK_DEST"
chmod +x "$HOOK_DEST"

echo "[pre-push-hook] Installed at $HOOK_DEST"
echo "[pre-push-hook] Secret scan will run before every 'git push'."