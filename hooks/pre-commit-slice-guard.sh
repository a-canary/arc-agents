#!/usr/bin/env bash
# G-0005 slice guard: structural check at commit time.
#
# Two checks:
#   1. ≤1 top-level area touched (cheap, deterministic; load-bearing)
#   2. Optional agentic focus analysis on the staged diff (bin/slice-guard-focus.ts)
#      Replaces the old flat 2000-modified-line cap. Asks an LLM per-hunk
#      whether each hunk advances the stated task; fails if drive-by % > cap.
#
# Top-level area = first path segment (e.g. "bin", "src", "skills", "hooks",
# "docs", "profiles"). Top-level files (CLAUDE.md, CONTEXT.md, etc.) count as
# area "_root".
#
# Focus analysis runs only when MINIMAX_API_KEY is set. Pre-commit can't see
# the final commit message, so we fall back to the current branch name as the
# intent signal — coarse but enough to flag obvious drive-bys.
#
# Bypass entire gate: SLICE_GUARD_SKIP=1 git commit ...
# Bypass focus only:  SLICE_GUARD_FOCUS_SKIP=1 git commit ...

set -euo pipefail

if [[ "${SLICE_GUARD_SKIP:-0}" == "1" ]]; then
  exit 0
fi

MAX_AREAS="${SLICE_GUARD_MAX_AREAS:-1}"

# Staged diff stats. --numstat: <added> <deleted> <path>
diff_output=$(git diff --cached --numstat --no-renames || true)

if [[ -z "$diff_output" ]]; then
  exit 0
fi

declare -A areas=()
while IFS=$'\t' read -r added deleted path; do
  [[ -z "${path:-}" ]] && continue
  area="${path%%/*}"
  if [[ "$area" == "$path" ]]; then
    area="_root"
  fi
  areas["$area"]=1
done <<< "$diff_output"

area_count=${#areas[@]}
area_list=$(printf '%s ' "${!areas[@]}")

fail=0
msgs=()
if (( area_count > MAX_AREAS )); then
  msgs+=("slice-guard: $area_count top-level areas touched ($area_list) > cap $MAX_AREAS")
  fail=1
fi

# Agentic focus analysis. Optional — requires MINIMAX_API_KEY.
if [[ "${SLICE_GUARD_FOCUS_SKIP:-0}" != "1" ]] && [[ -n "${MINIMAX_API_KEY:-}" ]]; then
  repo_root="$(git rev-parse --show-toplevel)"
  focus_bin="$repo_root/bin/slice-guard-focus.ts"
  if [[ -f "$focus_bin" ]]; then
    title="$(git rev-parse --abbrev-ref HEAD)"
    if ! bun "$focus_bin" --title "$title" --diff-args "--cached" >&2; then
      msgs+=("slice-guard: focus analysis FAIL — drive-by hunks exceed cap")
      fail=1
    fi
  fi
fi

if (( fail )); then
  printf '%s\n' "${msgs[@]}" >&2
  echo "  bypass with SLICE_GUARD_SKIP=1 git commit ..." >&2
  exit 1
fi

exit 0
