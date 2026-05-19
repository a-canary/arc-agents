#!/usr/bin/env bash
# Smoke test for hooks/pre-commit-slice-guard.sh.
# Sets up a throwaway git repo, stages various commits, and asserts the
# guard exit code.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/pre-commit-slice-guard.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cd "$tmp"
git init -q
git config user.email test@example.com
git config user.name test
git config commit.gpgsign false

mkdir -p src bin docs

# Case 1: single-area, small => pass
echo "hello" > src/a.txt
git add src/a.txt
if ! "$guard"; then
  echo "FAIL: single small change should pass" >&2
  exit 1
fi
git commit -q -m "init"

# Case 2: multi-area => fail
echo "x" > src/b.txt
echo "y" > bin/c.txt
git add src/b.txt bin/c.txt
if "$guard" 2>/dev/null; then
  echo "FAIL: multi-area change should fail" >&2
  exit 1
fi
git reset -q HEAD src/b.txt bin/c.txt
rm src/b.txt bin/c.txt

# Case 3: huge single-area => fail
mkdir -p src/big
python3 -c "import sys
for i in range(2500):
  print('line', i)" > src/big/blob.txt
git add src/big/blob.txt
if SLICE_GUARD_MAX_LINES=2000 "$guard" 2>/dev/null; then
  echo "FAIL: 2500-line change should fail cap=2000" >&2
  exit 1
fi

# Case 4: bypass env
if ! SLICE_GUARD_SKIP=1 "$guard"; then
  echo "FAIL: SLICE_GUARD_SKIP=1 should pass" >&2
  exit 1
fi

echo "ok: pre-commit-slice-guard tests pass"
