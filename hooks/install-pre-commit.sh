#!/usr/bin/env bash
# Install hooks/pre-commit-slice-guard.sh as .git/hooks/pre-commit.
# Idempotent: re-running replaces the symlink/file with the current version.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
src="$repo_root/hooks/pre-commit-slice-guard.sh"
git_dir=$(git rev-parse --git-dir)
# In worktrees, git-dir is .git/worktrees/<name>; common-dir is the real .git.
common_dir=$(git rev-parse --git-common-dir)
dest="$common_dir/hooks/pre-commit"

if [[ ! -x "$src" ]]; then
  chmod +x "$src"
fi

mkdir -p "$(dirname "$dest")"

if [[ -e "$dest" || -L "$dest" ]]; then
  rm -f "$dest"
fi

# Use a small shim so the hook always picks up the latest committed script.
cat > "$dest" <<'SHIM'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/hooks/pre-commit-slice-guard.sh" "$@"
SHIM
chmod +x "$dest"

echo "installed pre-commit slice guard -> $dest"
