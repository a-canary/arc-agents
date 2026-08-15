# ponytail-debt: arc-agents

Task: 000251-hygiene-arc-agents-ponytail-debt

## Summary

Scanned arc-agents repo for `ponytail:` annotations — inline developer markers noting edge cases, design decisions, and architectural watch-items. Second pass after audit (000242).

## Diff vs Audit (000242)

Audit found **33 markers** across **20 files** and emitted 31 hygiene tasks.

Since audit:

| Status | Count | Detail |
|--------|-------|--------|
| Resolved between audit and debt | 3 | `src/ledger/merge-truth.ts` (kill-on-timeout), `bin/merge-gate.sh` (file removed), `bin/feedback-aggregate.ts` (1 marker removed) |
| Resolved inline this pass | 3 | `bin/trash-sweep.test.ts` (dynamic date), `bin/recovery-sweep.ts` (probe comment), `bin/gate-triage.ts` (stamp-in-body) |
| New markers not in audit | 1 | `bin/plan.ts` (sequential chain) |
| New hygiene task emitted | 1 | improve-architecture: plan-ts-replace-seq |
| Remaining ponytail markers | 24 | across 13 files, all covered by audit's 31 hygiene tasks |

## Inline Resolutions (this pass)

### bin/trash-sweep.test.ts — RESOLVED
- Old: `ponytail: sweep_after must stay ahead of wall-clock or this fixture rots.`
- Resolution: `FUTURE_SWEEP_AFTER` was already dynamically computed from now + 5 years. Removed ponytail label; updated comment to reflect that concern is addressed.

### bin/recovery-sweep.ts — RESOLVED
- Old: `ponytail: probe only the first candidate — one candidate alive = alias produces work`
- Resolution: Design intent is clear and correct. Removed ponytail label; promoted to plain comment.

### bin/gate-triage.ts — RESOLVED
- Old: `ponytail: no schema change — the stamp lives in body_md`
- Resolution: Header comment already documents the stamp-in-body_md decision. Removed ponytail label; integrated into header.

## Hygiene Task Emitted (new, not in audit)

| ID | Skill | Title |
|----|-------|-------|
| improve-architecture-plan-ts-replace-seq | improve-architecture | plan.ts: replace sequential tracer chain with per-slice dependency edges for parallel slices |

## Remaining Markers (covered by audit tasks)

24 markers across 13 files, already covered by 000242's 31 emitted hygiene tasks:

- `bin/feedback-aggregate.ts` (4) — collector, webui stamp, pass-2 validation, row-count key
- `bin/plan-agent.ts` (3) — richer grounding, sibling repo, glob-over-list
- `bin/director-governor.ts` (2) — sentinel flags, per-director tokens
- `bin/vast-billing.ts` (2) — env var contract, temp+rename
- `bin/worker-shell.sh` (2) — fetch+merge guard, jq escaping
- `bin/ledger.ts` (2) — strict success, linear worktree probe
- `bin/vast-lease.ts` (1) — optional --dph
- `bin/vast-lease.test.ts` (1) — dph handoff
- `bin/vast-billing.test.ts` (1) — single fixture harness
- `bin/estate-secret-inventory.ts` (1) — gitleaks wrapper
- `bin/plan.ts` (1) — sequential chain (new, hygiene task emitted)
- `src/ledger/migrate.ts` (3) — free source string, free resolution, no CHECKs
- `src/ledger/cross-repo-gate.ts` (1) — mention heuristic

## Files Scanned

All `.ts`, `.sh`, `.js`, `.mjs`, `.mts`, `.md` files in the arc-agents repo (excluding `node_modules/`, `.git/`, `.claude/`).
