# ADR 0012 — Director Agent + AXI-conformant ledger

**Date:** 2026-06-30
**Status:** accepted
**Decides:** the Director Agent replaces the Planner, owns a project group, is steered by typed feedback, and delegates to the factory only through the `ledger` CLI (AXI)

---

## Context

The system grew a per-conversation **Planner**: a session that shaped one piece
of work and decomposed it into ledger rows. That model has no owner of a *group*
of projects, no standing intent it drives from, and no single, machine-stable
surface through which planning delegates execution. Steering was implicit —
every feedback row was treated the same regardless of who sent it or whether it
was an instruction or a guess — which let a single product-channel row mint a
PRD on its own.

This ADR records the decision to replace the Planner with a **Director Agent**
and to make the `ledger` CLI the sole delegation surface (the AXI — Agent
eXecution Interface).

## Problem

1. **No group owner.** Nothing autonomously holds the intent for a project group
   (`onenation`, `trading`, `arc-factory`, `ai-research`) and drives it forward
   between human touches.
2. **Untyped steering.** Feedback carried no notion of *mode* (is this an order
   or a hypothesis?) or *author trust* (operator vs product channel). The
   aggregate gate keyed on channel, so `source='direct'` degenerated into "any
   single row is trusted" → one product row could mint a PRD.
3. **No stable delegation contract.** Planning code reached into the ledger DB
   directly. Every consumer (factory, a future UI) re-implemented reads, so the
   partitioning logic for "what's done / in-flight / next" had no single home.

## Decision

**A. Director Agent owns a project group.** Role is selected by cwd
(`~/vault/agents/directors/<group>/`); the Director drives from that group's
`AGENTS.md` Mission file (vault state, never pushed). It runs autonomously and is
corrected by feedback, not by turn-by-turn instruction.

**B. Steering is typed on the author, not the channel.** Feedback rows gain
`mode` (`imperative` | `hypothesis`; NULL = unstamped, treated as hypothesis)
and `author_trust` (`operator` | `product`). The confirmation gate fires on **one
trusted (operator)** row **or three distinct untrusted (product)** submitters —
closing the `source='direct'` degeneracy. An imperative (`!`) from the operator
fires a direct verb now; a hypothesis validates on one concrete case before any
scale.

**C. The `ledger` CLI is the only delegation surface (AXI).** Director, factory
workers, and any UI read and write work exclusively through `ledger <verb>`.
Non-TTY output is a machine contract: array results stay JSON by default (TOON
opt-in via `--toon`), object reports are JSON. New verbs this feature adds:
`director-brief --project <P>` (done/current/next buckets) and the steering /
governor surfaces. No consumer re-reads the DB to reconstruct what a verb
already returns.

**D. Deep modules behind never-fatal shells.** Each capability is a pure compute
function — `encode`, `parse` (steering), `brief`, `gaps` (mission-gap),
`governor`, — wrapped in a thin I/O shell that always `process.exit(0)`. Pure
functions test in isolation with golden inputs; the shells carry no logic worth
testing.

**E. Bounded by a governor and the Reversible-Verb Boundary.** `governor(state)`
gates the Director on `KILL`/`PAUSE` sentinel files and a weekly token budget
(host-wide codeburn sum); it never fails fatally. Every verb the Director may
call is reversible — irreversible acts (deploys, secret edits, destructive
ledger ops, live trades) route to a HITL gate, never to a Director verb.

## Components (one slice each, all merged)

| Capability | Module (pure) | Verb / surface |
|---|---|---|
| TOON encode | `toon-encode` | non-TTY ledger output |
| ready-queue + hints | — | bare `ledger` |
| steering classifier | `parse(input)→{mode,payload}` | feedback intake |
| feedback typing | migration `025` | `mode`, `author_trust` cols |
| director scaffold | `directorGroupFromCwd` | A-0003 cwd routing |
| director-brief | `brief(gitLog,ledger,feedback)` | `director-brief --project P` |
| mission-gap | `gaps(mission,ledger)` | capped proposals, under budget |
| governor | `governor(state)` | `KILL`/`PAUSE` + weekly token cap |

## Consequences

- A standing, group-scoped owner exists; the per-conversation Planner is retired.
- Trust is honest: an operator's single word acts; product noise needs corroboration.
- The AXI CLI is a stable contract — a UI (see arc-webui `/director/plan`) consumes
  `director-brief` over the CLI rather than duplicating the `brief()` deep module.
- The Mission files live in the vault (operator overlay, A-0004), so the Director's
  intent is steerable without a code change and never leaks to a public repo.
- Rejected: letting the Director call irreversible verbs directly (collapses the
  Reversible-Verb Boundary); keying trust on channel (the degeneracy this fixes).
