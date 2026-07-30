---
name: spec-to-tickets
description: "Decompose a PRD (kind=prd row or PRD-*.md file) into N sprint ledger rows, each a tracer-bullet thin vertical slice with Requirements + Success criteria in body_md."
---

# spec-to-tickets — spec → Sprint Row Decomposition

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
   - Project assignment: default is `arc-agents` (this skill's own repo). If the spec's deliverable describes files, UI, or behavior that live in a *different* repo (the PRD names another repo like "a-canary/webui", or references paths that don't exist under this repo root), set `--project <that-repo>` in step 3 instead of leaving it to default. Do not let a slice land in the PRD's home repo just because that's where the PRD/skill happens to run — route it to the repo the work actually touches. (Observed: PRD `mobile-first-responsive-shell-viewport-m` emitted 4 slices describing arc-webui drawer/CSS work, all filed with the arc-agents default project — workers claiming them found no matching code to touch.)

   **Verify every dependency claim in the brief before emitting it.** If a sprint title or PRD paragraph says "on top of X that already exists" / "cheap add to existing Y" / "as a follow-on to the merged Z" — grep the target repo for X/Y/Z before writing the sprint. If the claim is false (no tile, no helper, no merged slice), either rewrite the brief so it does not depend on the phantom, or fold the missing piece into the slice scope (allowed only when the missing piece is the *same* tracer bullet, not a separate hidden dependency). Briefs that promise "cheap add on top of" a thing that doesn't exist waste a worker cycle waiting on a phantom. Observed: task `idle-bleed-flag-emphasise-any-running-bo` had a brief claiming "cheap add on top of the data the tile already reads" but no tile existed in `arc-webui/`; the worker shipped reader + tile + emphasis as one slice. The fix is upstream — don't emit the phantom-dependency brief in the first place.

3. **Write via bookie.** For each sprint spec:
   ```
   ledger.ts create --kind sprint --type deferred --title "<title>" \
     --body "<## Requirements\n...\n## Success criteria\n...>" \
     --tier <tier> --pool <pool> --agent sprint [--project <target-repo>]
   ```
   Omit `--project` only when the spec's deliverable is confirmed to live in this repo. All creates go through the bookie.

4. **Return** the list of created sprint ids.

## Constraints

- Sprint body_md MUST include both `## Requirements` and `## Success criteria` — the sprint-supervise skill reads them to determine done.
- Keep each sprint atomic: one thin vertical. If a sprint needs more than 5 children to execute, it's not thin enough — split it further at PRD decomposition time.
- Do not create task rows. The output is sprint rows only. The sprint supervisor fans out to task children at runtime.
