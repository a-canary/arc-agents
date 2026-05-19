---
name: grill-with-docs
description: "Intake-frame skill. Stress-test user intent against CONTEXT.md glossary and docs/adr/ before decomposing into ledger rows. Sharpen terminology, surface ambiguity, update docs inline as decisions crystallise."
---

# grill-with-docs — Align Intent Against Project Docs

Used by intake-frame workers (event/interactive, prd/mvp) at the start of a
thread, before any decomposition into ledger rows. Mirrors the canonical
mattpocock skill of the same name, adapted for the arc-agents intake flow
(see CHOICES.md UX_1, [intake](../../CONTEXT.md#intake-ux_1)).

## When to use

- First turn of a new chat thread spawned via `bin/arc-chat.ts post`.
- Any time the user's message introduces a term, concept, or scope that may
  not match the project's existing domain language.
- Before calling `choose-wisely` — alignment precedes cascade.

## How

1. Read [CONTEXT.md](../../CONTEXT.md) glossary entries relevant to the user's message.
2. Read any [docs/adr/](../../docs/adr/) records the message touches.
3. Reflect the user's intent back in project terminology. Name the entities
   (Ledger, Issue, Worker, Factory, Interviewer, Bookie, Claim, Decomposition,
   Worktree, Reap) explicitly.
4. Surface mismatches: terms the user used that aren't in CONTEXT.md, or that
   collide with existing definitions. Ask one sharp question per mismatch.
5. If a new term emerges that the project will need to keep using, propose a
   CONTEXT.md addition inline. If a scoped decision crystallises, propose a
   CHOICES.md line. Don't write either silently — confirm with the user first.

## Output shape

A short reply tagged with the thread_id, posted via `chat_out`. Either:

- A clarifying question (one, sharp, evidence-anchored), or
- A confirmed alignment statement followed by the intent to hand off to
  `choose-wisely` next turn.

## Related

- [[choose-wisely]] — runs after alignment to cascade design choices.
- [[ke-recall]] — surfaces prior decisions before grilling.
