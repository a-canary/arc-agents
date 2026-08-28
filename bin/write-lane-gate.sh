#!/usr/bin/env bash
# write-lane-gate.sh — merge-time write-lane check (DESIGN.md invariant 7).
# Runs arc-director's ONE shared check (src/policy/check.ts) over the PR diff
# file list. Paths are mapped to the CANONICAL repo root (where the writes
# land on merge), not the staging worktree — worktrees are ephemeral scratch,
# the durable write is the merge into the canonical checkout.
#
# Usage: bin/write-lane-gate.sh --project <path>
#   ARC_DIRECTOR env (default ~/repos/arc-director) locates the shared check.
#   LEDGER_DB env (default ~/vault/ledger.db) is consulted for lane-approve
#   human-gate events that unlock out-of-lane prefixes.
# Exit 0 = all diff files in-lane (or no base ref / empty diff — nothing to gate)
# Exit 1 = LANE_BLOCKED (allowlist printed on stderr by the shared check)
# Exit 2 = shared check unavailable (fail-closed, like secret-scan's gitleaks)

set -euo pipefail

PROJECT=""
CANON_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --canon-root) CANON_ONLY="$2"; shift 2 ;;
    *) shift ;;
  esac
done
# Canonical repo root: where the writes land on merge.
#   plain repo      <root>/.git              -> <root>
#   linked worktree <main>/.git/worktrees/n  -> <main> (merge lands in main checkout)
#   bare repo       <root>                   -> <root>
canon_root() {
  local gitdir
  gitdir="$(git -C "$1" rev-parse --absolute-git-dir)" || return 1
  case "$gitdir" in
    */.git)             cd "$(dirname "$gitdir")" && pwd ;;
    */.git/worktrees/*) cd "$(dirname "$gitdir")/../.." && pwd ;;
    *)                  cd "$gitdir" && pwd ;;
  esac
}
if [ -n "$CANON_ONLY" ]; then
  canon_root "$CANON_ONLY"
  exit 0
fi
if [ -z "$PROJECT" ]; then
  echo "usage: write-lane-gate.sh --project <path>" >&2
  exit 2
fi

ARC_DIRECTOR="${ARC_DIRECTOR:-$HOME/repos/arc-director}"
LEDGER_DB="${LEDGER_DB:-$HOME/vault/ledger.db}"
CHECKER="$ARC_DIRECTOR/src/policy/check.ts"
if [ ! -f "$CHECKER" ]; then
  echo "[write-lane] ERROR: shared check not found at $CHECKER (set ARC_DIRECTOR)." >&2
  echo "[write-lane] Cannot verify the write lane — failing closed." >&2
  exit 2
fi

CANON_ROOT="$(canon_root "$PROJECT")" || {
  echo "[write-lane] ERROR: cannot resolve canonical root for $PROJECT" >&2
  exit 2
}

# Base of the PR diff: first resolvable default-branch candidate.
BASE=""
for cand in origin/main main master origin/HEAD; do
  if git -C "$PROJECT" rev-parse --verify --quiet "$cand" >/dev/null; then
    BASE="$(git -C "$PROJECT" merge-base "$cand" HEAD || true)"
    [ -n "$BASE" ] && break
  fi
done
if [ -z "$BASE" ]; then
  echo "[write-lane] SKIP: no base ref (origin/main|main|master) resolvable in $PROJECT" >&2
  exit 0
fi

# Diff file list, NUL-safe; map each repo-relative path to its landing path.
# ponytail: mapfile -d needs bash >= 4.4 (fine on Linux factory hosts; macOS
# default bash 3.2 would die here) — upgrade path: while IFS= read -r -d '' loop.
mapfile -d '' REL < <(git -C "$PROJECT" diff --name-only -z "$BASE..HEAD")
if [ "${#REL[@]}" -eq 0 ]; then
  echo "[write-lane] SKIP: empty diff $BASE..HEAD" >&2
  exit 0
fi
TARGETS=()
for f in "${REL[@]}"; do TARGETS+=("$CANON_ROOT/$f"); done

if ! out="$(bun "$CHECKER" --db "$LEDGER_DB" "${TARGETS[@]}" 2>&1)"; then
  printf '%s\n' "$out" >&2
  exit 1
fi
echo "[write-lane] PASS: ${#TARGETS[@]} diff file(s) in-lane (canonical root $CANON_ROOT)"
exit 0
