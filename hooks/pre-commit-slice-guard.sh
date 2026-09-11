#!/usr/bin/env bash
# G-0005 slice guard: fail commit if staged changes exceed ~2000 modified-line
# equivalents or span more than one top-level area.
#
# Top-level area = first path segment (e.g. "bin", "src", "skills", "hooks",
# "docs", "profiles"). Top-level files (CLAUDE.md, CONTEXT.md, etc.) count as
# area "_root".
#
# `.claude/` is a SATELLITE area, not an area of its own: agent/skill
# definitions are prose describing behavior implemented in code elsewhere, and
# `bun test` skips dotted dirs so the verifying test cannot be colocated there.
# A `.claude/` doc + the code/test that proves it is one atomic slice. It only
# counts as an area when it is the *only* thing staged.
#
# Bypass: SLICE_GUARD_SKIP=1 git commit ...

set -euo pipefail

if [[ "${SLICE_GUARD_SKIP:-0}" == "1" ]]; then
  exit 0
fi

MAX_LINES="${SLICE_GUARD_MAX_LINES:-2000}"
MAX_AREAS="${SLICE_GUARD_MAX_AREAS:-1}"

# Staged diff stats. --numstat: <added> <deleted> <path>
diff_output=$(git diff --cached --numstat --no-renames || true)

if [[ -z "$diff_output" ]]; then
  exit 0
fi

total=0
declare -A areas=()
while IFS=$'\t' read -r added deleted path; do
  [[ -z "${path:-}" ]] && continue
  # binary files show "-" "-"; skip line counting
  if [[ "$added" != "-" ]]; then
    total=$(( total + added + deleted ))
  fi
  area="${path%%/*}"
  if [[ "$area" == "$path" ]]; then
    area="_root"
  fi
  areas["$area"]=1
done <<< "$diff_output"

# Satellite: drop `.claude` unless it is the only area staged.
if [[ -n "${areas[.claude]:-}" ]] && (( ${#areas[@]} > 1 )); then
  unset 'areas[.claude]'
fi

area_count=${#areas[@]}
area_list=$(printf '%s ' "${!areas[@]}")

fail=0
msgs=()
if (( total > MAX_LINES )); then
  msgs+=("slice-guard: $total modified-line equivalents > cap $MAX_LINES")
  fail=1
fi
if (( area_count > MAX_AREAS )); then
  msgs+=("slice-guard: $area_count top-level areas touched ($area_list) > cap $MAX_AREAS")
  fail=1
fi

if (( fail )); then
  printf '%s\n' "${msgs[@]}" >&2
  echo "  bypass with SLICE_GUARD_SKIP=1 git commit ..." >&2
  exit 1
fi

exit 0
