#!/bin/bash
# lint-no-hardcoded-author.sh — enforce I-0006 (no hardcoded commit authors).
#
# Commit author must resolve from `git config user.name` / `user.email`.
# Hardcoded literals (e.g. "a-canary", "aaron.canary", "noreply@anthropic.com",
# "Co-Authored-By: ...") in non-test source under bin/ and src/ are forbidden.
#
# Allowed: tests (*.test.ts, src/**/__fixtures__/**), comments, this script.
#
# Exit 0 = clean. Exit 1 = violation found (prints offenders to stderr).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Literal patterns that would only appear if someone hardcoded an identity.
# Keep narrow: real usernames/emails/co-author trailers tied to a person.
PATTERNS=(
  'a-canary'
  'aaron\.canary'
  'noreply@anthropic\.com'
  'Co-Authored-By:'
)

# Files to scan: bin/ and src/, excluding *.test.ts and fixture dirs.
mapfile -t FILES < <(
  find bin src \
    \( -name '*.test.ts' -o -path '*/__fixtures__/*' -o -path '*/fixtures/*' \) -prune \
    -o -type f \( -name '*.ts' -o -name '*.js' -o -name '*.sh' \) -print 2>/dev/null \
    | grep -v "bin/lint-no-hardcoded-author.sh"
)

violations=0
for f in "${FILES[@]}"; do
  for pat in "${PATTERNS[@]}"; do
    # Strip // and # line comments before matching so doc references don't trip.
    if awk '
      {
        line=$0
        sub(/[[:space:]]*\/\/.*$/, "", line)
        sub(/[[:space:]]*#.*$/, "", line)
        print line
      }
    ' "$f" | grep -nE "$pat" >/dev/null 2>&1; then
      echo "VIOLATION: $f matches /$pat/" >&2
      grep -nE "$pat" "$f" >&2 || true
      violations=$((violations+1))
    fi
  done
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "[lint-no-hardcoded-author] $violations violation(s). See I-0006 in CHOICES.md." >&2
  exit 1
fi

echo "[lint-no-hardcoded-author] clean (scanned ${#FILES[@]} file(s))"
exit 0
