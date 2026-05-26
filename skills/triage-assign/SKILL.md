---
name: triage-assign
description: "Agent-actor triage loop. Batch-claims rows with agent='agent_unset' OR pool='pool_unset', assigns {tier, pool, agent} per payload + context, writes via bookie."
---

# triage-assign — Unset Row Assignment Loop

Drains ledger rows missing `agent` or `pool` assignment. This is the **agent-actor backstop** to `bin/factory.ts`'s `triageUnset` pure-SQL heuristic (shipped in PR-3, I-0011). The factory's SQL rule covers obvious cases (kind=task → agent=developer, kind=sprint → agent=sprint, etc.); `triage-assign` handles the hard cases the heuristic punts on — ambiguous payloads, mixed-kind parents, cross-context rows.

When factory dispatches a `agent=triage` row, this is the skill it runs.

## Inputs

No flags required. The worker claims `agent_unset` / `pool_unset` rows atomically from the ledger (via bookie) and processes them in batch.

## Procedure

1. **List unset rows.**
   ```
   ledger.ts list --agent agent_unset --limit 20
   # also
   ledger.ts list --pool pool_unset --limit 20
   ```
   Deduplicate (a row may have both unset).

2. **For each row, read payload + context.**
   - `ledger.ts show <id>` — kind, tier, title, body_md, parent_id.
   - Parent row if present: kind + body_md (what does the parent expect of children?).
   - Sibling rows (same parent): existing agent/pool assignments (for consistency).

3. **Assign {tier, pool, agent}.**
   Apply these rules in order:

   | Signal | Assignment |
   |---|---|
   | kind=sprint | agent=sprint, pool=build |
   | kind=event, source_module=arc-chat | agent=chat, pool=interactive |
   | kind=task, body mentions "HITL" or "human review" | agent=chat, pool=interactive |
   | kind=task, body mentions deploy/infra/ops | agent=admin, pool=ops |
   | kind=task (default) | agent=developer, pool=build |
   | kind=prd | agent=director, pool=build |

   Escalate (read parent PRD, sibling evidence, CHOICES.md sections) only for genuinely ambiguous payloads — the triage profile is cheap by default.

4. **Write via bookie.**
   ```
   ledger.ts update <id> --agent <a> --pool <p> [--tier <t>]
   ```
   All writes through bookie.

5. **Loop** until no unset rows remain (or until a reasonable batch limit is reached — stop at 50 per cycle to avoid runaway).

## Constraints

- Never reassign a row that already has a non-unset agent AND a non-unset pool — even if you disagree with the assignment. Idempotent within one triage session.
- Prefer the factory's SQL heuristic rules above — only override when payload evidence is conclusive.
- This skill does NOT create new rows. Only updates agent/pool/tier on existing rows.
