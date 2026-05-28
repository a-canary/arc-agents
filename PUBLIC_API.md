# Public API Reference

> **Status: 0.x — experimental.** APIs, schemas, and CLIs may break without notice
> within the 0.x range. Pin to a specific minor version (e.g. `"arc-agents": "0.1.2"`)
> when integrating.

This document is the authoritative reference for arc-agents' public surface.
The README provides a human-readable overview; this file provides machine-parsable
reference for tooling, plugins, and CI integration.

---

## CLI — `ledger` binary

Entrypoint: `bin/ledger.ts` → `bun link` → `ledger` on PATH.

**Verb reference** (I-0001):

| Verb | Purpose | Notes |
|---|---|---|
| `init` | Bootstrap ledger db, run migrations | `--db <path>` optional; defaults to `~/vault/ledger.db` |
| `create` | Insert new issue row | Flag-only, no positional args (PRD-v1 §4) |
| `claim` | Attempt atomic claim of one ready row | Returns `{ok, issue}` or `{ok: false}` |
| `update` | Mutate issue fields (state, blocked_by, agent, pool, tier, …) | `--state <s>` `--id <id>` required |
| `event` | Append event to issue's timeline | `--id <id>` `--kind <k>` `--body <md>` |
| `list` | Query issues | `--state`, `--pool`, `--agent`, `--hitl`, `--json` flags |
| `show` | Full issue + events | `--id <slug>` |
| `tick` | Factory dispatch tick | Spawn ready workers |
| `spawn-ready` | Spawn workers for all ready issues matching agent/pool | Debug/admin |
| `render-prompt` | Render system prompt for claimed issue | Includes thread replay |
| `compact` | Rewrite WAL → normal mode | Admin |
| `vacuum` | VACUUM the ledger db | Admin |
| `doctor` | Diagnose ledger health (orphans, phantom claims, schema drift) | Admin |
| `decompose` | Emit N child issues, block parent | Worker tool |
| `hygiene-emit` | Queue hygiene followup | Worker tool |
| `hitl` | Create a HITL prompt | `--class taste|impact` `--repo` `--branch` |
| `backfill-phantom-claims` | Fix stale claim rows | Admin |
| `resolve-alias` | Resolve issue slug to id | Admin |
| `alias-cmd` | Show alias resolution for a command | Admin |

**State machine** (G-0001):

```
ready → claimed → wip → review → merged
                         ↘ blocked
                   ↘ failed
              ↘ cancelled
```

Blocked issues activate when all `blocked_by` dependencies reach `merged`.

**Flag conventions**: long flags only (`--state`, `--id`). Positional args after verb
are always rejected for `create` (PRD-v1 §4).

---

## Exported Library API

Exposed via `src/ledger/` as ESM.

### `src/ledger/db.ts`

```typescript
open(path?: string): Database           // open existing WAL db, fail if absent
openWithMigrate(path?: string): Database // open + run pending migrations, fail if no schema
migrate(db: Database): AppliedMigration[] // returns list of applied migrations
```

### `src/ledger/kinds.ts`

```typescript
KINDS: readonly string[]        // all valid issue kinds
TYPES: readonly string[]        // all valid issue types
STATES: readonly string[]       // all valid states (includes terminal)
CLAIMABLE_STATES: readonly string[]  // ready | blocked
CLAIMABLE_KINDS_SQL: string    // SQL fragment for claim query
```

### `src/ledger/bookie-validator.ts`

```typescript
validateCreate(input: CreateInput): ValidatedRow  // throws on invalid
validateStateTransition(from: State, to: State): void  // throws on invalid
validateDecompose(parentId, childCount): void   // throws on invalid
// CreateInput fields: title, body_md, acceptance_md, type, kind,
//   hitl, tier, pool, agent, source_module, parent_id, blocked_by
```

### `src/ledger/claim.ts`

```typescript
claimOnce(db: Database, workerId: string, poolFilter?: Pool): ClaimResult | null
buildClaimSQL(poolFilter?: Pool): string  // for debugging / admin tools
```

### `src/ledger/tier-pool-sort.ts`

```typescript
SORT_KEY_SQL: string  // SQL ORDER BY expression for tier/pool priority
```

### `src/ledger/hitl-prompt.ts`

```typescript
insertHitlPrompt(db, input: HitlPromptInput): HitlPromptRow
buildPayload(input: HitlPromptInput): string  // serialize payload_md
```

### `src/ledger/hitl-schemas.ts`

```typescript
hitlKind: HitlKind               // 'taste' | 'impact'
UX_VERBS: readonly string[]      // ['ask_text', 'ask_choice', 'ask_confirm', 'notify', 'show_artifact']
UX_RENDER_STRATEGIES: readonly string[]  // ['native', 'rasterize-png', 'ascii-degrade', 'unsupported']
```

### `src/ledger/ux-config.ts`

```typescript
loadConfig(): UxConfig
pickModulesForHitl(verb: string, artifactType: string): UxModule[]
```

### `src/ledger/worktree-reaper.ts`

```typescript
reapStaleWorktrees(db: Database, maxAgeSec: number): ReapResult
```

### `src/ledger/hygiene-dedup.ts`

```typescript
checkDuplicate(db, skill: HygieneSkill, title: string): ExistingRow | null
```

### `src/profiles/load.ts`

```typescript
loadProfile(cwd: string): RoleProfile
loadProfileByRole(role: Agent): RoleProfile
```

### `src/worker/templates.ts`

```typescript
renderSystemPrompt(issue: IssueRow, thread: ThreadRow[]): string
```

---

## Config — `~/.config/arc/config.yaml`

Schema: `system/config-schema.json`. Example: `system/config.example.yaml`.

**Top-level key**: `ux_modules` (array).

**Per-module fields**:

| Field | Type | Notes |
|---|---|---|
| `name` | string | kebab-case, unique |
| `implements` | string[] | subset of UX_VERBS |
| `renders` | object | per-artifact-type render strategy |
| `can_retract` | boolean | if module can undo a render |
| `cli` | string | binary on PATH, implements ledger `hitl-delivery` ops |
| `pusher` | string\|null | async medium daemon; null for sync mediums |
| `heartbeat.interval_sec` | number | seconds between heartbeat writes |
| `heartbeat.stale_after_sec` | number | considered stale after this gap |

**Artifact types** (U-0006):

- `text/markdown`
- `text/diff`
- `chart/vega-lite`
- `diagram/mermaid`
- `image/png`
- `table/rows`

**Render strategies**:

- `native` — render as-is
- `rasterize-png` — convert to image
- `ascii-degrade` — text fallback for diagrams/charts
- `truncate-codeblock` — truncate at 2000 chars
- `unsupported` — skip delivery

---

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `LEDGER_DB` | Path to SQLite ledger | `~/vault/ledger.db` |
| `ARC_CLAIM_POOL` | Worker pool filter for claim | none (claims any pool) |
| `ARC_CLAIM_TYPE` | Deprecated alias for `ARC_CLAIM_POOL` | none |
| `ARC_TICK_DISABLE` | Disable factory dispatch tick | not set (tick runs) |
| `ARC_TRIAGE_DISABLE` | Disable `triageUnset` auto-classification | not set |
| `ARC_TRIAGE_BUDGET` | Override `triageUnset` budget | `10` |
| `ARC_WEBUI_IFACE` | Override Tailscale interface for webui | auto-detect |

---

## Version Pinning

Use **SemVer** with a pinned minor: `"arc-agents": "^0.1.2"` or `"arc-agents": "0.1.2"`.
Never use `latest` or bare `*` in production integrations.

Breaking changes within 0.x are considered non-conforming; report deviations
as bugs.

---

## Version History

| Version | Notes |
|---|---|
| 0.1.0 | Initial tagged release; ledger, factory, bookie, factory, skills |
| 0.2.0 | HITL schema, UX Module Contract, arc-tui, arc-webui scaffolding |
| 0.3.0 | Hygiene cron, deploy preview probe, arc-replay |
| 0.4.0 | Worktree reaper, stale claim sweeper, doctor command |