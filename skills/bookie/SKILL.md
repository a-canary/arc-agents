---
name: bookie
description: "Sole writer of ledger rows. Validates kind/type/state, mints slug ids, emits 'created' event. Adds `decompose` verb that turns a PRD into a chain of TDD slices."
---

# bookie — Ledger Row Writer

Agents do NOT write to `~/vault/ledger.db` directly. They invoke bookie with row intent; bookie validates and writes.

## Why a subagent

- Single chokepoint for CHECK-constraint enforcement (`kind`, `type`, `state`, `hitl`, `blocked_by` JSON shape).
- Centralizes slug minting + collision suffixing.
- Emits the canonical `created` issue_event with caller agent identity.

## Enums

- `kind`: `task`, `chat_in`, `encounter_reply`, `prd`
- `type` (priority order — claim picks lowest first): `HITL`, `cron`, `mvp`, `security`, `quality`, `scale`, `efficiency`, `deferred`
- `state` (terminal: `merged`, `cancelled`): `ready`, `claimed`, `wip`, `blocked`, `review`, `merged`, `cancelled`, `failed`

## Verbs

### `create` — single row

Inputs:

| Flag | Required | Notes |
|---|---|---|
| `--kind` | yes | enum above |
| `--type` | yes | enum above |
| `--title` | yes | slug minted from this |
| `--project` | no | defaults to `arc-agents` |
| `--body` | no | markdown body |
| `--acceptance` | no | markdown acceptance criteria |
| `--parent` | no | parent issue id |
| `--blocked-by` | no | JSON array of issue ids |
| `--dry` | no | wraps insert in `BEGIN; … ROLLBACK;` and prints |

Procedure:

1. Run:
   ```
   bun ~/repos/arc/packages/arc-agents/bin/ledger.ts create \
     --kind <k> --type <ty> --title "<t>" --project <p> \
     [--body "<md>"] [--acceptance "<md>"] [--parent <id>] [--blocked-by '<json>']
   ```
2. CLI mints id (slug + 4-char base36 collision suffix), inserts row, emits `created` event.
3. Return row id.

### `decompose` — PRD → chained TDD slices

Use when a PRD is ready to break down into thin vertical tracer-bullet slices. Slices are sequenced via `blocked_by` so workers pull them in order.

Inputs (one of):
- `--prd <path>` — path to PRD markdown (typically `.scratch/<slug>/PRD.md`)
- `--text <md>` — inline PRD text

Optional:
- `--project <name>` — defaults to the repo enclosing the PRD path, else `arc-agents`
- `--parent <id>` — parent issue id (e.g. the PRD row itself)

Procedure:

1. Read the PRD. Extract user stories (the "As an X, I want Y, so that Z" list) and acceptance criteria.
2. Ask the LLM for a thin vertical tracer-bullet TDD slice list. Each slice must be:
   - Acceptance-testable in isolation.
   - Sized to one short PR (≈ one worker turn).
   - Ordered: foundations first, then features that depend on them.
3. For each slice in order:
   - Call `create` with `--kind task --type mvp --title "<slice-title>"`, `--parent <prd-id>` if known, and `--blocked-by '[<previous-slice-id>]'` for every slice after the first.
4. Return the ordered list of new ids.

Notes:
- All decompose-created rows are `type=mvp`. Owners re-classify individual rows after the fact (e.g. flip one to `HITL`) by updating directly via ledger CLI.
- If the LLM proposes a slice that is cleanup, refactor, or scaffolding with no acceptance test, push back: a slice without an acceptance test is not a tracer-bullet slice and should be folded into a real one.

## Validation (pre-insert)

1. Reject if `kind` not in enum.
2. Reject if `type` not in enum.
3. Reject if `state` (if supplied) not in enum; default `ready`, or `blocked` when `blocked_by` is non-empty.
4. Reject if `blocked_by` is not a JSON string array.
5. Reject any positional args to `create` (flag-only).

## Errors

- CHECK violation → return error with offending column.
- Unique id collision after 5 retries → escalate (should never happen with 4-char suffix on slug).
- Schema migration not applied → run `bun ~/repos/arc/packages/arc-agents/src/ledger/migrate.ts` first.
