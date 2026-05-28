---
name: prd-to-issues
description: "Decompose a PRD (kind=prd row or PRD-*.md file) into N sprint ledger rows, each a tracer-bullet thin vertical slice with Requirements + Success criteria in body_md."
---

# prd-to-issues — PRD → Sprint Row Decomposition

Turns a product requirements document into N sprint ledger rows. Each sprint is a tracer-bullet thin vertical — one deliverable, one acceptance bar.

For the decomposition heuristic, reference the `/to-prd` skill at `~/.claude/plugins/` for the PRD structure this skill reads, and the matt-pocock `/to-issues` skill for the overall decomposition shape. The output here is sprint rows, not generic task rows.

## Inputs

- A PRD row id (`kind=prd`, any state) **or** a PRD-*.md file path.

## Procedure

1. **Read the PRD.** Pull the body_md from the ledger row (`ledger.ts show <id>`) or read the file. Extract goals, constraints, acceptance criteria.

2. **Decompose into N sprint specs.** Each spec is one tracer-bullet thin vertical:
   - One concrete deliverable (a runnable thing, a shipped feature, a validated experiment).
   - A `## Requirements` section (what it must do).
   - A `## Success criteria` section (how to verify done — observable, binary).
   - Tier assignment: `trust` (security/irreversible), `mvp` (current sprint priority), `explore` (research), `defer` (known-want, no timeline).
   - Pool assignment: `build` (implementation), `explore` (research/validation), `interactive` (requires human mid-task), `ops` (infra/deploy).

3. **Write via bookie.** For each sprint spec:
   ```
   ledger.ts create --kind sprint --type deferred --title "<title>" \
     --body "<## Requirements\n...\n## Success criteria\n...>" \
     --tier <tier> --pool <pool> --agent sprint
   ```
   All creates go through the bookie.

4. **Return** the list of created sprint ids.

## Constraints

- Sprint body_md MUST include both `## Requirements` and `## Success criteria` — the sprint-supervise skill reads them to determine done.
- Keep each sprint atomic: one thin vertical. If a sprint needs more than 5 children to execute, it's not thin enough — split it further at PRD decomposition time.
- Do not create task rows. The output is sprint rows only. The sprint supervisor fans out to task children at runtime.
