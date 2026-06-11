#!/usr/bin/env bash
# hooks/install-pre-commit.sh — opt-in installer for the G-0005 slice guard.
#
# Usage:  bash hooks/install-pre-commit.sh
#
# Idempotent:
#   - absent hook            → install fresh
#   - already a slice-guard  → no-op (prints "already")
#   - different hook present → back up as pre-commit.installed-by-slice-guard.<ts>
#                              and replace
#
# The installed .git/hooks/pre-commit is a thin shim that execs the in-tree
# script resolved via `git rev-parse --show-toplevel`, so the install is
# portable across worktrees of the same repo.
#
# Uninstall: rm .git/hooks/pre-commit
# Bypass on a single commit: SLICE_GUARD_SKIP=1 git commit ...

set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO" ]]; then
  echo "install-pre-commit: not inside a git working tree" >&2
  exit 1
fi

HOOKS_DIR="$REPO/.git/hooks"
TARGET="$HOOKS_DIR/pre-commit"
SOURCE="$REPO/hooks/pre-commit-slice-guard.sh"

if [[ ! -f "$SOURCE" ]]; then
  echo "install-pre-commit: $SOURCE not found" >&2
  exit 1
fi

mkdir -p "$HOOKS_DIR"

# Idempotency check: if the target is already a slice-guard shim, exit clean.
# Detection: file exists AND its body references the in-tree script path.
if [[ -f "$TARGET" ]] && grep -q 'pre-commit-slice-guard\.sh' "$TARGET" 2>/dev/null; then
  echo "install-pre-commit: $TARGET already installs slice guard (no-op)"
  exit 0
fi

# Different hook present — back it up before replacing.
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  BACKUP="$TARGET.installed-by-slice-guard.$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "install-pre-commit: backed up existing hook → $BACKUP" >&2
fi

# Write a shim that execs the in-tree guard, resolving toplevel at run time
# so the same shim works from any worktree of this repo.
cat > "$TARGET" <<'SHIM'
#!/usr/bin/env bash
# Installed by hooks/install-pre-commit.sh — execs the G-0005 slice guard.
exec "$(git rev-parse --show-toplevel)/hooks/pre-commit-slice-guard.sh" "$@"
SHIM
chmod +x "$TARGET"

echo "install-pre-commit: installed $TARGET"
