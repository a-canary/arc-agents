#!/usr/bin/env bash
# hooks/sweep-secret-guard-estate.sh — install the secret guard pre-commit
# hook and .env gitignore patterns across every git repo under $REPOS_ROOT.
#
# Usage:  bash hooks/sweep-secret-guard-estate.sh [--dry-run]
#
# Per repo, idempotently:
#   1. .gitignore gains `.env` / `.env.*` / `!.env.example` if missing;
#      the change is committed as the configured git user (nothing else
#      staged is touched — commit only pathspec .gitignore).
#   2. .git/hooks/pre-commit becomes a shim exec-ing the canonical guard
#      in this repo (symlink-pattern: one source of truth, edited here).
#      An existing foreign hook is backed up and chained after the guard.
#
# arc-agents itself is skipped for step 2 — its installer
# (hooks/install-pre-commit.sh) chains slice guard + secret guard.
#
# Uninstall per repo: rm .git/hooks/pre-commit (restore the .bak if chained).

set -euo pipefail

REPOS_ROOT="${REPOS_ROOT:-$HOME/repos}"
GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-commit-secret-guard.sh"
# Sweep installs must point at the canonical checkout, not a transient
# worktree that gets recycled after merge.
CANONICAL_GUARD="$REPOS_ROOT/arc-agents/hooks/pre-commit-secret-guard.sh"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

[[ -f "$GUARD" ]] || { echo "sweep: guard not found: $GUARD" >&2; exit 1; }

for repo in "$REPOS_ROOT"/*/; do
  repo="${repo%/}"
  [[ -d "$repo/.git" ]] || continue
  name="$(basename "$repo")"

  # --- .gitignore sweep ---
  gi="$repo/.gitignore"
  missing=()
  for pat in ".env" ".env.*"; do
    grep -qxF "$pat" "$gi" 2>/dev/null || missing+=("$pat")
  done
  if (( ${#missing[@]} )); then
    if (( DRY_RUN )); then
      echo "$name: would add to .gitignore: ${missing[*]}"
    else
      { [[ -s "$gi" ]] && [[ -n "$(tail -c1 "$gi" 2>/dev/null)" ]] && echo; \
        printf '%s\n' "${missing[@]}" "!.env.example"; } >> "$gi"
      git -C "$repo" add .gitignore
      git -C "$repo" commit --quiet -m "chore: gitignore .env (secret-guard estate sweep)" -- .gitignore
      echo "$name: .gitignore updated + committed (${missing[*]})"
    fi
  fi

  # --- hook install (skip arc-agents: its own installer chains both guards) ---
  [[ "$name" == "arc-agents" ]] && continue
  hook="$repo/.git/hooks/pre-commit"
  if [[ -f "$hook" ]] && grep -q 'secret-guard shim v2' "$hook"; then
    continue
  fi
  if (( DRY_RUN )); then
    echo "$name: would install secret-guard hook"
    continue
  fi
  chain=""
  # An older shim of ours gets overwritten in place (preserving any chained
  # foreign-hook backup line), never chained onto itself.
  if [[ -f "$hook" ]] && grep -q 'sweep-secret-guard-estate\.sh' "$hook"; then
    chain="$(grep -o '"[^"]*pre-secret-guard[^"]*" "\$@"' "$hook" || true)"
    rm "$hook"
  fi
  if [[ -f "$hook" ]]; then
    bak="$hook.pre-secret-guard.$(date +%s)"
    mv "$hook" "$bak"
    chain="\"$bak\" \"\$@\""
    echo "$name: existing pre-commit backed up to $(basename "$bak") and chained"
  fi
  mkdir -p "$repo/.git/hooks"
  cat > "$hook" <<SHIM
#!/usr/bin/env bash
# Installed by arc-agents hooks/sweep-secret-guard-estate.sh (secret-guard shim v2)
set -e
if [[ -f "$CANONICAL_GUARD" ]]; then
  "$CANONICAL_GUARD" "\$@"
else
  echo "secret-guard: $CANONICAL_GUARD missing — skipping (re-run arc-agents hooks/sweep-secret-guard-estate.sh)" >&2
fi
$chain
SHIM
  chmod +x "$hook"
  echo "$name: secret-guard hook installed"
done
