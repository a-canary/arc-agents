---
name: arc-agents
description: Discover the arc-agents verbs that touch the ledger (SQLite ledger.db, the bookie CLI, the issue/write/event surface). Use when you want to know which arc-agents skills/clis will actually write, mutate, or read the ledger — and which do not belong here (those live in arc-skills).
---

# arc-agents — ledger-aware verbs

This skill is a router for the arc-agents skills that depend on the ledger (`~/vault/ledger.db`, the `bookie` CLI, sprint/event machinery). If a verb does not mutate or read the ledger, it does NOT belong here — it lives in **arc-skills** (the shared skills repo).

## Ledger-dependent verbs (this repo)

| Verb | What it does |
|---|---|
| `bookie` | Sole writer of ledger rows. Validates kind/type/state, mints slug ids, emits `created` event. Adds `decompose` verb that turns a PRD into a chain of TDD slices. |
| `bookie-tdd` | TDD template for bookie subagent tasks. Pure-validator TDD, fixture patterns, table-driven cases, red-green-refactor. |
| `prd-to-issues` | Decompose a PRD into N sprint ledger rows, each a tracer-bullet thin vertical slice with `Requirements + Success criteria` in `body_md`. |
| `spawn` | Worker decomposition verb. Inserts child ledger rows under the current task, wires `parent.blocked_by` to the new children, flips parent to `blocked`. NOT a process spawn. |
| `sprint-supervise` | Re-entrant sprint supervisor loop. Drives a single thin vertical slice to evidence-backed done across re-entry cycles: load prior handoffs, check evidence, complete or decompose, write re-entry handoff, tear down. |
| `to-ledger` | Owner-facing flow for filing a single ledger row. Walks the user through the required flags, then delegates the write to `bookie`. |
| `triage-assign` | Agent-actor triage loop. Batch-claims rows with `agent='agent_unset'` OR `pool='pool_unset'`, assigns `{tier, pool, agent}` per payload + context, writes via `bookie`. |
| `triage-failed` | Director-subagent skill. Classifies a `state=failed` ledger row as low-risk (auto-decompose into slices, cancel parent) vs needs-HITL (mark for human review). |
| `deploy-preview` | Cron probe. Scans ledgers for open issues with non-null `pr_url`, finds deploy preview URLs, emits `deploy_preview` events. |
| `report-friction` | One-line write to the shared feedback table (a ledger row). Self-guided portal aggregates into proposals. Use instead of derailing your current task. |
| `stale-draft-sweep` | Auto-close dead draft PRs older than `staleDraftDays` (default 14d): comment with evidence via `gh`, then close. Emits ledger events. Never deletes branches. |
| `analyse-recent-sessions` | Read N recent worker tmux scrollbacks / handoff events, identify recurring friction, write a new skill or update an existing one. Ledger-driven — mines the event bus. |

## What does NOT belong here

Non-ledger verbs (e.g. `to-trash`-style general actions, generic docs, generic code review, generic refactors) live in the **arc-skills** repo and are not surfaced by this skill. If you need a verb that does not touch the ledger, look there first.

## Quick command surface

```bash
# Most-used ledger verbs at the CLI
bookie create --kind task --class hygiene --title "..."
bookie list --state ready --role developer
bookie list --hitl 1
bookie update <id> --state done
bookie event <id> --type handoff --body.md ...
bookie tick           # cron-style: surfaces ready work, fans out
```

## When you do NOT need this skill

- The task is purely repository-level (refactor, docs, tests, code review) — no ledger mutation in sight. Go straight to arc-skills (`code-review`, `diff-review`, `improve-architecture`, `clarify-docs`, etc.).
- You only need to recall a previous finding — use `ke-recall` (arc-skills).
- You only need to write a noscript decision outside the ledger — use `to-trash` (arc-skills) or `feedback`.
