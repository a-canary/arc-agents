---
name: choose-wisely
description: "Intake-frame skill. Cascade design choices through CHOICES.md tiers (M/A/G/S/D/I) — higher tier constrains lower. Resolve up/downstream choices triggered by a new decision, then hand off to bookie for ledger decomposition."
---

# choose-wisely — Cascade Through CHOICES.md

Used by intake-frame workers (event/interactive, prd/mvp) after
`grill-with-docs` has aligned terminology. Resolves the cascade of scoped
decisions a user request implies, against the tiered ledger in
[CHOICES.md](../../CHOICES.md). See CHOICES.md UX_1 and the
[Decisions: CHOICES vs ADR](../../CHOICES.md#decisions-choices-vs-adr) note.

## Tiers (higher constrains lower)

- **M-*** mission — product goals.
- **A-*** architecture — actor topology, bus, persistence.
- **G-*** design — invariants, hard constraints.
- **S-*** skills — agent capabilities.
- **D-*** data — schemas, file layouts.
- **I-*** implementation — concrete tooling.

## When to use

- After `grill-with-docs` reaches shared alignment on intent.
- Before handing off to `bookie` for ledger row creation.
- Any time a user request implies a decision not yet recorded in CHOICES.md.

## How

1. Identify the lowest tier the request touches (e.g. "swap SQLite for Postgres"
   is A-tier; "rename CLI verb" is I-tier).
2. Walk upward: does the request violate any higher-tier choice? If yes, the
   decision is not yours to make alone — decompose into a HITL child (see
   [AGENTS.md §2](../../roles/AGENTS.md)).
3. Walk downward: does the request force any lower-tier choices to change?
   List them. Each becomes a candidate CHOICES.md line or a ledger row.
4. Propose new CHOICES.md lines inline (tier-prefixed, one line each). Confirm
   with the user before persisting.
5. Hand off the aligned + cascaded scope to bookie, which writes the ledger
   rows.

## Output shape

A short reply via `chat_out` listing the cascade: tier hit, upstream
constraints satisfied (or HITL needed), downstream choices forced, and the
ledger rows about to be created.

## Related

- [[grill-with-docs]] — runs before, aligns terminology.
- [[bookie]] — runs after, persists the decomposition.
