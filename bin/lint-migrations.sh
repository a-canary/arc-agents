#!/bin/bash
# Copyright 2026 a-canary
# Licensed under the Apache License, Version 2.0
# SPDX-License-Identifier: Apache-2.0

# lint-migrations.sh — enforce G-0007 (no symlinks during migrations).
#
# Scans src/ledger/migrate.ts and any migration files for symlink usage.
# Forbidden patterns: symlink(, symlinkSync, ln -s
#
# Usage: bin/lint-migrations.sh [--project <path>]
# Exits 1 on any hit, 0 on clean tree.

set -euo pipefail

PROJECT="${PROJECT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$PROJECT" ]; then
  PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

TARGETS=()
[ -f "$PROJECT/src/ledger/migrate.ts" ] && TARGETS+=("$PROJECT/src/ledger/migrate.ts")
if [ -d "$PROJECT/src/ledger/migrations" ]; then
  while IFS= read -r f; do TARGETS+=("$f"); done < <(find "$PROJECT/src/ledger/migrations" -type f \( -name '*.ts' -o -name '*.sql' \) 2>/dev/null)
fi
if [ -d "$PROJECT/migrations" ]; then
  while IFS= read -r f; do TARGETS+=("$f"); done < <(find "$PROJECT/migrations" -type f \( -name '*.ts' -o -name '*.sql' \) 2>/dev/null)
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "lint-migrations: no migration files found, nothing to scan"
  exit 0
fi

PATTERN='symlink\(|symlinkSync|ln -s'
HITS=$(grep -nE "$PATTERN" "${TARGETS[@]}" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "lint-migrations: G-0007 violation — symlink usage forbidden in migrations" >&2
  echo "$HITS" >&2
  exit 1
fi

echo "lint-migrations: OK (${#TARGETS[@]} file(s) scanned)"
exit 0