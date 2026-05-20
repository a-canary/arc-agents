---
name: bookie
description: "Sole writer of ledger rows. Validates kind/type/state, mints slug ids, emits 'created' event. Adds `decompose` verb that turns a PRD into a chain of TDD slices."
---

# bookie — Ledger Row Writer

Agents do NOT write `~/vault/ledger.db` directly — they invoke bookie with row intent and bookie validates + writes. Single chokepoint for CHECK-constraint enforcement, slug minting + collision suffixing, and the canonical `created` issue_event tagged with caller identity.

## Enums

- `kind`: `task`, `chat_in`, `encounter_reply`, `prd`
- `type` (claim picks lowest priority first): `HITL`, `cron`, `mvp`, `security`, `quality`, `scale`, `efficiency`, `deferred`
- `state` (terminal: `merged`, `cancelled`): `ready`, `claimed`, `wip`, `blocked`, `review`, `merged`, `cancelled`, `failed`

## Verbs

### `create` — single row

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

```
bun ~/repos/arc-agents/bin/ledger.ts create \
  --kind <k> --type <ty> --title "<t>" --project <p> \
  [--body "<md>"] [--acceptance "<md>"] [--parent <id>] [--blocked-by '<json>']
```

CLI mints id (slug + 4-char base36 collision suffix), inserts row, emits `created` event. Returns row id.

### `decompose` — PRD → chained TDD slices

Breaks a ready PRD into thin vertical tracer-bullet slices sequenced via `blocked_by` so workers pull them in order.

Inputs (one of): `--prd <path>` (typically `.scratch/<slug>/PRD.md`), or `--text <md>` (inline).
Optional: `--project <name>` (defaults to repo enclosing the PRD path, else `arc-agents`), `--parent <id>` (e.g. the PRD row itself).

Procedure:

1. Read the PRD. Extract user stories and acceptance criteria.
2. Ask the LLM for a TDD slice list — each slice acceptance-testable in isolation, sized to ≈ one worker turn, foundations before dependents.
3. For each slice in order, call `create` with `--kind task --type mvp --title "<slice-title>"`, `--parent <prd-id>` if known, and `--blocked-by '[<previous-slice-id>]'` for every slice after the first.
4. Return the ordered list of new ids.

All decompose rows are `type=mvp`; owners re-classify via direct ledger CLI after the fact. If the LLM proposes a cleanup/refactor/scaffolding slice with no acceptance test, push back — fold it into a real tracer-bullet slice.

## Validation (pre-insert)

1. Reject if `kind` not in enum.
2. Reject if `type` not in enum.
3. Reject if `state` (if supplied) not in enum; default `ready`, or `blocked` when `blocked_by` is non-empty.
4. Reject if `blocked_by` is not a JSON string array.
5. Reject any positional args to `create` (flag-only).

## Errors

- CHECK violation → return error with offending column.
- Unique id collision after 5 retries → escalate (should never happen with 4-char suffix).
- Schema migration not applied → run `bun ~/repos/arc-agents/src/ledger/migrate.ts` first.
