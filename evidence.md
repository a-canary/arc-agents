Completed: clarify-docs for full sequential chain dependency pattern at bin/plan.ts:112.

Deliverables:
- CONTEXT.md: Added "Sequential Tracer Chain" glossary entry documenting the `--blocked-by` JSON array format for each tracer position, `unblock_dependents` release semantics, known ceiling (cancelled tracer strands successors), recovery paths (failed reset via `ledger update --state ready`; cancelled tracer I-0010 gap), and upgrade path (per-slice dependency edges from plan-agent).
- bin/plan.ts: Ponytail annotation shortened to cross-reference: "The Sequential Tracer Chain pattern is documented in CONTEXT.md (glossary entry)." Preserved the per-slice future note.
- evidence.md: Updated with final state.

PR: https://github.com/a-canary/arc-agents/pull/436
Diff review: self-review (no subagent extension available in pi harness; doc-only diff), verdict=pass, no surprises/gaps/conflicts.

Commits:
- 8c2b5e7 clarify-docs: document full sequential chain dependency pattern in CONTEXT.md
- c424e75 clarify-docs: promote ponytail annotation to reference CONTEXT.md glossary entry
- 6f22ab7 clarify-docs: update evidence.md with final state for sequential chain pattern
