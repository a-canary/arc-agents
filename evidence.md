Added "Sequential Tracer Chain" glossary entry to CONTEXT.md documenting the full sequential chain dependency pattern used by `bin/plan.ts`:

- Concrete `--blocked-by` JSON array format for each tracer position (tracer 0 blocked only on PRD; tracer N blocked on PRD + tracer N-1)
- `unblock_dependents` SQL trigger release semantics (all blockers must reach `merged`)
- Known ceiling: cancelled tracer strands all successors since `unblock_dependents` only fires on `merged` state transitions
- Recovery paths: failed tracer resets via `ledger update --state ready`; cancelled tracer has no CLI path due to `repoint-blocked-by` rejecting terminal-state blockers (CHOICES I-0010 gap)
- Upgrade path (ponytail): per-slice dependency edges from plan-agent when genuinely parallel slices matter

CONTEXT.md glossary entry committed at d85670e.
bin/plan.ts ponytail annotation promoted to reference CONTEXT.md.
Branch pushed to origin: worker/clarify-docs-plan-full-sequential-chain-
