# ADR 0004 — Agent Doctrine in `roles/AGENTS.md`

**Status:** Accepted (2026-05-17)
**Supersedes:** none. Ports the doctrine half of `~/agents/roles/AGENTS.md` (the predecessor framework).

## Context

`~/agents/` carried a thick doctrine layer in `roles/AGENTS.md`: Evidence-First, Concern Protocol, Pattern detection, Leave-it-Clearer, the Session Pattern template, and "When Confused → ke:research → /advice". These weren't decorative — they shaped how every worker reasoned about scope, escalation, failure attribution, and session boundaries.

arc-agents' early docs (`CLAUDE.md`, `CONTEXT.md`, `CHOICES.md`, the PRDs) had no equivalent. The doctrine was either implicit, baked into per-skill prompts, or simply missing. A fresh worker session had no shared epistemological frame.

## Decision

Port the doctrine, but reshape it for the ledger-dispatched, ephemeral-worker model:

1. **One file: `roles/AGENTS.md`** — referenced by every role profile's `context_files`.
2. **CONTEXT.md gets three new glossary entries**: `evidence-first`, `concern`, `pattern` — names only, definitions only, no implementation detail. (Matt Pocock's DDD rule: CONTEXT.md is a glossary, not a spec.)
3. **`Concern` is redefined as HITL Decomposition.** The predecessor's `outbox/concern-*.md` mechanism doesn't fit the ledger model. The semantics survive; the mechanism becomes a row-write via bookie + a `parent.blocked_by` flip. This is the load-bearing reshape — without it, workers would either invent a parallel concern surface or stall.
4. **"When Confused → /advice" is partially dropped.** `/advice` is not ported (yet). The doctrine keeps ke-recall + grep + HITL-decompose as the three escape valves.

## Alternatives considered

- **Inline doctrine in each profile JSON's `context_summary`.** Rejected: drift between roles, hard to amend, no single source.
- **Bake into per-skill prompts only.** Rejected: doctrine cuts across skills (e.g. Evidence-First applies whether you're running `grill-with-docs` or `triage-failed`). Skill-level prompts can't enforce session-wide habits.
- **CONTEXT.md entries with the doctrine inline.** Rejected: violates the DDD-glossary rule. CONTEXT.md gets *names* for the doctrines (evidence-first, concern, pattern) so they're nameable in worker speech; the *content* lives in roles/AGENTS.md.
- **ADR-only, no separate doctrine file.** Rejected: ADRs are narrative records of past decisions, not always-loaded session context. The doctrine needs to be in every worker's startup read.

## Consequences

**Positive.** Every worker session boots with a shared frame for scope, escalation, failure attribution, and shutdown. Pattern detection has a documented home (`triage-failed`). The vocabulary mismatch with the predecessor system is bridged (concern → HITL decomposition is named, not implicit).

**Negative / costs.** `roles/AGENTS.md` adds tokens to every session's context window. Mitigated: the file is short (~200 lines), and the alternatives (inline per profile, inline per skill) would cost the same or more in aggregate.

**Trade-off taken.** Doctrine is centralized at the cost of a small per-session context tax. The win is coherence across roles and a clean migration path for the predecessor's vocabulary.

## Implementation notes

- Profiles (`profiles/admin.json`, `developer.json`, `director.json`) should include `roles/AGENTS.md` in `context_files`. Future specialist profiles (researcher, reviewer, prototyper) inherit the same.
- The interviewer reads it too: `grill-with-docs` runs against `CONTEXT.md` *and* `AGENTS.md` so doctrine terms are interview-anchored.
- The "Leave It Clearer" §4 mention of `to-trash` is forward-looking — that tool is not yet ported from `~/agents/bin/to-trash.ts`. Re-evaluate once ported.
