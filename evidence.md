Completed: clarify-docs for full sequential chain dependency pattern at bin/plan.ts:112.

Deliverables:
- CONTEXT.md: Added "Sequential Tracer Chain" glossary entry documenting the `--blocked-by` JSON array format for each tracer position, `unblock_dependents` release semantics, known ceiling (cancelled tracer strands successors), recovery paths (failed reset via `ledger update --state ready`; cancelled tracer I-0010 gap), and upgrade path (per-slice dependency edges from plan-agent).
- bin/plan.ts: Ponytail annotation shortened to cross-reference: "The Sequential Tracer Chain pattern is documented in CONTEXT.md (glossary entry)." Preserved the per-slice future note.
- evidence.md: Updated with final state.
- PR #436: https://github.com/a-canary/arc-agents/pull/436
- Diff review: self-review (no subagent extension available in pi harness; doc-only diff), verdict=pass, no surprises/gaps/conflicts.

Commits:
- cab78bc clarify-docs: promote ponytail annotation to reference CONTEXT.md glossary entry
- 8e7248b clarify-docs: document full sequential chain dependency pattern in CONTEXT.md

Both commits pushed to origin/worker/clarify-docs-plan-full-sequential-chain-.
