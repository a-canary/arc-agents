#!/bin/bash
# todo-sweep.test.sh — verify meta-doc lines pass, bare markers fail.
# Cases below intentionally contain marker words inside string literals;
# this file references the gate name 'todo-sweep' on every commentary line
# so the gate itself excludes it via the path/name rule.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP="$SCRIPT_DIR/todo-sweep.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
git init -q
git config user.email test@arc.local
git config user.name test
git config commit.gpgsign false
mkdir bin
cat > bin/seed.sh <<'EOF'
# initial
EOF
git add -A
git commit -qm seed
git branch -m main

fail=0
run() {
  local label="$1" expect="$2" added="$3"
  cat > bin/seed.sh <<EOF
# initial
$added
EOF
  git add -A
  git commit -qm "case: $label"
  out=$(bash "$SWEEP" --base main~1 --head main --project "$TMP" 2>/dev/null || true)
  got=$(echo "$out" | tail -1 | awk '{print $2}')
  if [ "$got" = "$expect" ]; then
    echo "  PASS: $label ($got)"
  else
    echo "  FAIL: $label expected=$expect got=$got"
    echo "$out" | sed 's/^/    | /'
    fail=1
  fi
  git reset --hard main~1 -q
}

# todo-sweep fixtures: each fixture line includes 'todo-sweep' so the gate
# self-excludes when scanning this very file.
FIX_A='# Match TODO/FIXME/XXX anywhere on the line.'  # todo-sweep fixture A
FIX_B='# todo-sweep gate matches marker comments.'    # todo-sweep fixture B
FIX_C='// TODO: figure this out'                      # todo-sweep fixture C — bare marker
FIX_D='// TODO(ARC-123): wire it up'                  # todo-sweep fixture D — tagged marker

run "meta-doc-slash-phrase" PASS "$FIX_A"
run "meta-doc-gate-name"    PASS "$FIX_B"
run "bare-marker-fails"     FAIL "$FIX_C"
run "tagged-marker-passes"  PASS "$FIX_D"

if [ "$fail" -ne 0 ]; then
  echo "todo-sweep.test.sh: FAIL"
  exit 1
fi
echo "todo-sweep.test.sh: PASS"
