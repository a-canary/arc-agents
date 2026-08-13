# Decision: Plan-agent reads existing PRDs via `ledger list` glob, not bookie SQL

**Date:** 2026-07-13 (ponytail annotation at `bin/plan-agent.ts:266`)
**Status:** accepted
**Row:** `clarify-docs-plan-agent-glob-over-ledger`
**Observed in:** `000242-hygiene-arc-agents-ponytail-audit`

---

## TL;DR

`listExistingPrdIds()` at `bin/plan-agent.ts:270` spawns `ledger list --kind prd
--all --project <p>` and parses the JSON stdout, rather than wiring a new
SQL query into the bookie subagent for this read-only lookup. The `ledger list`
CLI already supports the needed filters (`--kind`, `--project`), returns JSON,
and at ~hundreds of PRDs the parse cost is trivial vs. the LLM research call
that consumes the result. Keeps the bookie surface small.

## Context

The L6 Planning Agent (`plan-agent.ts`, ADR-0010) classifies every proposed PRD
against existing in-flight and recently-proposed PRDs via pairwise
`orthogonal|replace|dependency|fork` relationships (see `Plan.relationships`).
To do this, the prompt needs the list of existing PRD slugs for the target
project.

The function that supplies this list (`listExistingPrdIds`) is a **pure read**
— it never mutates ledger state. It runs as a synchronous subprocess before the
`claude -p` research engine even starts.

## Decision

Use `bun bin/ledger.ts list --kind prd --all --project <p>` — the existing
ledger CLI — and parse the JSON stdout in-process, rather than routing the
query through the bookie subagent or adding a direct `better-sqlite3` query.

## Alternatives considered

| Alternative | Rejected because |
|---|---|
| **Bookie SQL query** — teach the bookie subagent a new `ledger-prds` verb that runs a raw SQL SELECT | Wiring a read-only query into the bookie creates a second query interface that must be maintained, documented, and kept in sync with `ledger list`; the bookie's contract is write authority, not query offload |
| **Direct `better-sqlite3` import** — `plan-agent.ts` opens `ledger.db` directly | Creates a second DB connection path with its own connection-lifecycle concerns; plan-agent already runs as a short-lived subprocess, so the overhead of spawning `ledger list` is a one-time ~5ms cost |
| **Pass existing PRDs via caller arg** — require the webui caller to supply the list | The caller (arc-webui /chat) doesn't have the list; it would need to query the ledger too, pushing the same problem one level up |

## Consequences

- **Positive:** The `ledger list` CLI is the single, tested, documented query interface. Any future filter (`--state`, `--tier`, `--pool`) is immediately available to `listExistingPrdIds` with zero code changes.
- **Positive:** No new bookie verbs. The bookie subagent stays focused on write authority (create, update, decompose, event).
- **Positive:** Trivial to extend — if the function later needs `state` or `tier` columns, the `ledger list` JSON already includes them.
- **Neutral:** Subprocess spawn + JSON parse overhead (~5-10ms) is negligible vs. the 300s `claude -p` research call.
- **Negative:** The function depends on `ledger.ts` being at a sibling path (`join(import.meta.dir, "ledger.ts")`), which means plan-agent must run from the arc-agents repo. The `resolveProjectRepo` gate (line 304) already enforces this indirectly.

## Cross-references

- `bin/plan-agent.ts:266` — ponytail annotation
- `bin/plan-agent.ts:270` — `listExistingPrdIds` implementation
- `docs/api.md` — `ledger list` CLI reference
- ADR-0010 (`docs/adr/0010-chat-reply-triage.md`) — plan-agent design
