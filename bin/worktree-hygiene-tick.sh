#!/usr/bin/env bash
# worktree-hygiene-tick.sh — cron glue for bin/worktree-hygiene.ts.
#
# WHY THIS EXISTS
# The cron used to run the scanner straight out of the main checkout:
#   0 4 * * * bun /home/aaron/repos/arc-agents/bin/worktree-hygiene.ts
# That executes the main checkout's WORKING TREE — whatever branch it happens
# to be parked on, plus any uncommitted edits. On 2026-09-11 the checkout sat
# on `worker/map-ontology-intake-improve-architecture`, so the nightly sweep
# filed real ledger rows (000109/000110/000111) from a stale, unreviewed,
# unmerged copy of the scanner. A worker checking out a different branch
# silently changed what production ran overnight.
#
# This wrapper pins the cron to COMMITTED code at a known ref, in a checkout
# nothing else touches. The main checkout stays a human/worker scratch space.
#
# THE REF IS NOT `main` (yet). bin/worktree-hygiene.ts does not exist on main —
# it lives in an unmerged stacked PR chain (#485 -> #518). Pinning to main today
# would turn the sweep into a silent no-op, which is strictly worse than stale
# code: no rows, no signal, nobody notices. So the ref is configurable and
# defaults to the chain tip. Once the chain merges, drop the override and this
# collapses to plain `main` with no other change.
#
# Config (~/.config/arc-agents/env, read by cron-preamble.sh):
#   ARC_HYGIENE_REF=main          # ref to run from; default below
#
# Manual run (same code path as cron, useful for verifying a ref change):
#   bin/worktree-hygiene-tick.sh
# NOTE: there is no dry-run. The scanner FILES LEDGER ROWS on every run, and it
# ignores unrecognised argv rather than rejecting it — so `--dry-run` looks like
# it worked and writes rows anyway. Verify a ref change with `--ref-check`
# below, which syncs and resolves the pin without invoking the scanner.
#   bin/worktree-hygiene-tick.sh --ref-check
#
# Exit codes: 0 clean (incl. no-op), 2 hygiene config error (from the scanner),
# non-zero if sync or the scanner throws — the ERR trap files a ledger error.
. "$(dirname "${BASH_SOURCE[0]}")/cron-preamble.sh"
set -euo pipefail

SRC_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Default to the unmerged chain tip that carries the worktree-age abandonment
# gate (PR #518). Flip to `main` the moment #485..#518 land.
REF="${ARC_HYGIENE_REF:-worker/analyse-recent-sessions-worktree-hygiene}"
# Dedicated checkout: not ~/repos/arc-agents (workers repoint that constantly)
# and not ~/worktrees/* (the scanner's own sweep target — it would scan itself).
PINNED="${ARC_HYGIENE_CHECKOUT:-$HOME/.cache/arc-agents-pinned}"
BUN="${BUN:-/home/aaron/.bun/bin/bun}"
LOCK=/tmp/arc-worktree-hygiene-tick.lock

sync_pinned() {
  if [ ! -d "$PINNED/.git" ]; then
    # Local clone off the on-disk repo — no network, no auth, and it works
    # while the chain is unmerged and unpushed.
    git clone --quiet --no-checkout --shared "$SRC_REPO" "$PINNED"
  fi
  # Pull the ref's current commit from the source repo each tick, so a merged
  # chain (or a fixed scanner) is picked up without re-provisioning anything.
  git -C "$PINNED" fetch --quiet "$SRC_REPO" "+$REF:refs/arc/pinned"
  # Hard reset, not checkout: the pinned tree is disposable and must never
  # accumulate drift. This is the whole point of the wrapper.
  git -C "$PINNED" -c advice.detachedHead=false checkout --quiet --force --detach refs/arc/pinned
  git -C "$PINNED" reset --quiet --hard refs/arc/pinned
  git -C "$PINNED" clean -qfd
}

sync_pinned

SCAN="$PINNED/bin/worktree-hygiene.ts"
if [ ! -f "$SCAN" ]; then
  # Fail loud, not silent: a ref without the scanner means the pin is wrong.
  # A quiet exit 0 here would recreate the exact "nobody noticed" failure
  # this wrapper exists to prevent.
  echo "worktree-hygiene: $SCAN missing at ref '$REF' — fix ARC_HYGIENE_REF" >&2
  exit 1
fi

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ref=$REF commit=$(git -C "$PINNED" rev-parse --short HEAD) ==="

# --ref-check: prove the pin resolves without running the scanner. The scanner
# has no dry-run and ignores unknown argv, so passing it a made-up flag files
# real rows. This is the only safe way to verify a ref change by hand.
if [ "${1:-}" = "--ref-check" ]; then
  echo "worktree-hygiene: ref-check OK — scanner present, scanner NOT run"
  exit 0
fi

# flock -n: one sweep at a time; a long sweep makes the next tick a no-op
# rather than stacking two scanners filing duplicate rows.
exec flock -n "$LOCK" "$BUN" "$SCAN" "$@"
