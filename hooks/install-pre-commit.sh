#!/usr/bin/env bash
# hooks/install-pre-commit.sh — opt-in installer for the G-0005 slice guard
# and the secret guard.
#
# Usage:  bash hooks/install-pre-commit.sh
#
# Idempotent:
#   - absent hook            → install fresh
#   - already this shim      → no-op (prints "already")
#   - different hook present → back up as pre-commit.installed-by-slice-guard.<ts>
#                              and replace
#
# The installed hook (in the shared common git dir) is a thin shim that execs
# the in-tree scripts, preferring the current worktree's copy and falling back
# to the main worktree's, so the install is portable across worktrees and a
# guard fix is exercised by the commit that lands it.
#
# Uninstall: rm .git/hooks/pre-commit
# Bypass on a single commit: SLICE_GUARD_SKIP=1 SECRET_GUARD_SKIP=1 git commit ...

set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO" ]]; then
  echo "install-pre-commit: not inside a git working tree" >&2
  exit 1
fi

# Hooks live in the common git dir, shared by every worktree. In a worktree
# $REPO/.git is a FILE, not a directory, so deriving the hooks dir from the
# toplevel makes the installer unrunnable from any worktree.
COMMON_DIR="$(git rev-parse --git-common-dir)"
case "$COMMON_DIR" in /*) ;; *) COMMON_DIR="$PWD/$COMMON_DIR" ;; esac
HOOKS_DIR="$COMMON_DIR/hooks"
TARGET="$HOOKS_DIR/pre-commit"
SOURCE="$REPO/hooks/pre-commit-slice-guard.sh"
SECRET_SOURCE="$REPO/hooks/pre-commit-secret-guard.sh"

if [[ ! -f "$SOURCE" ]]; then
  echo "install-pre-commit: $SOURCE not found" >&2
  exit 1
fi
if [[ ! -f "$SECRET_SOURCE" ]]; then
  echo "install-pre-commit: $SECRET_SOURCE not found" >&2
  exit 1
fi

mkdir -p "$HOOKS_DIR"

# Idempotency check: if the target already chains both guards, exit clean.
if [[ -f "$TARGET" ]] && grep -q 'pre-commit-slice-guard\.sh' "$TARGET" 2>/dev/null \
   && grep -q 'pre-commit-secret-guard\.sh' "$TARGET" 2>/dev/null; then
  echo "install-pre-commit: $TARGET already installs both guards (no-op)"
  exit 0
fi

# Different hook present — back it up before replacing.
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  BACKUP="$TARGET.installed-by-slice-guard.$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "install-pre-commit: backed up existing hook → $BACKUP" >&2
fi

# Write a shim that execs the in-tree guards, resolved at run time so the same
# shim works from any worktree of this repo.
cat > "$TARGET" <<'SHIM'
#!/usr/bin/env bash
# Installed by hooks/install-pre-commit.sh — chains the G-0005 slice guard
# and the secret guard. Either can block the commit.
set -e

# Prefer the CURRENT worktree's copy of a guard, so a commit that fixes a guard
# is checked by the fixed guard and not by main's stale one. Fall back to the
# main worktree (parent of the git common-dir) when the current branch predates
# the script, then skip — a missing guard must not hard-fail every commit and
# train people into --no-verify.
common_dir="$(git rev-parse --git-common-dir)"
case "$common_dir" in /*) ;; *) common_dir="$PWD/$common_dir" ;; esac
toplevel="$(git rev-parse --show-toplevel)"
main_tree="$(dirname "$common_dir")"

run_guard() {
  local name="$1"; shift
  local guard="$toplevel/hooks/$name"
  [[ -x "$guard" ]] || guard="$main_tree/hooks/$name"
  [[ -x "$guard" ]] || return 0
  "$guard" "$@"
}

run_guard pre-commit-slice-guard.sh "$@"
run_guard pre-commit-secret-guard.sh "$@"
SHIM
chmod +x "$TARGET"

echo "install-pre-commit: installed $TARGET"
