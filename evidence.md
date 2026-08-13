Completed: clarify-docs for full sequential chain dependency pattern.

The work was completed and merged to main as PR #439 (commit 4848364)
before this worker claimed the row. Evidence of the PR:

- PR: https://github.com/a-canary/arc-agents/pull/439
- Merge commit: 48483645258f5416b36979f3c3316d6478330583
- Merge time: 2026-08-13T13:20:09Z

Deliverables (from PR #439):
- CONTEXT.md: Added "Sequential Tracer Chain" glossary entry documenting:
  - `--blocked-by` JSON array format for each tracer position
  - `unblock_dependents` SQL trigger release semantics
  - Known ceiling (cancelled tracer strands successors)
  - Recovery paths (failed reset via `ledger update --state ready`; cancelled tracer I-0010 gap)
  - Upgrade path (per-slice dependency edges from plan-agent)
- bin/plan.ts:112: Ponytail annotation promoted to cross-reference CONTEXT.md glossary entry
