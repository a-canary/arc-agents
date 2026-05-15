---
name: to-ledger
description: "Owner-facing flow for filing a single ledger row. Walks the user through the required flags, then delegates the write to bookie."
---

# to-ledger — File a Ledger Row

Use when the owner wants to file a single ledger row by hand (one task, one PRD, one chat row). For decomposing a PRD into a chain of slices use bookie's `decompose` verb instead.

## Required from owner

| Flag | Allowed values |
|---|---|
| `--kind` | `task`, `chat_in`, `encounter_reply`, `prd` |
| `--type` | `HITL`, `cron`, `mvp`, `security`, `quality`, `scale`, `efficiency`, `deferred` |
| `--title` | Free text. Slug minted from this. |
| `--project` | Repo name (`arc-agents`, `arc-webui`, …). Defaults to `arc-agents`. |

## Optional

| Flag | Notes |
|---|---|
| `--body` | Markdown body |
| `--acceptance` | Acceptance criteria, markdown |
| `--parent` | If subtask, parent issue id |
| `--blocked-by` | JSON array of issue ids, e.g. `'["i-foo"]'` |

## Type priority enum (canon)

Ordered most-to-least urgent:

1. `HITL` — needs human-in-the-loop
2. `cron` — scheduled work that must run on time
3. `mvp` — current sprint feature work
4. `security` — vulns, audit findings
5. `quality` — flaky tests, lint debt
6. `scale` — perf work that isn't blocking yet
7. `efficiency` — cost / speed optimizations
8. `deferred` — known-want, no committed timeline

Workers claim rows in this order (with ties broken by id).

## Procedure

1. If owner gave only a sentence (e.g. "file a task to fix the broken hooks loader"), ask for the missing required flags before doing anything else.
2. Delegate to bookie:
   ```
   bun ~/repos/arc-agents/bin/ledger.ts create \
     --kind <k> --type <ty> --project <p> --title "<t>" \
     [--body "<md>"] [--acceptance "<md>"] [--blocked-by '<json>'] [--parent <id>]
   ```
3. Return the new id to the owner so they can copy it for follow-ups.

## Dry-run

If unsure, pass `--dry` — bookie wraps the insert in `BEGIN; … ROLLBACK;` and prints what would be inserted.
