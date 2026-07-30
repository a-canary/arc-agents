# arc-agents Public API Reference

**Status: 0.1.0 — pre-alpha.** All exports are subject to breaking change
without notice.

---

## CLI Verbs

All entry via `bun bin/ledger.ts <verb> [flags]`.

| Verb | Description | Notes |
|---|---|---|
| `init` | Run pending migrations | Safe to re-run; skips already-applied |
| `create` | Create a ledger issue | Flag-only (no positional args) |
| `claim <worker>` | Atomic claim of one `ready` row | Used by factory + bash bootstrap |
| `update <id>` | Update state, evidence, PR URL, etc. | Validates transitions |
| `event <id> <kind> "<payload>"` | Append an audit event | |
| `list [--state S] [--kind K] [--limit N]` | List issues | |
| `show <id>` | Full row + event history | |
| `decompose <parent-id>` | Decompose into task children | Atomic; parent → `blocked`; children inherit parent `type`/`pool`/`tier` |
| `join-status <id>` | Pure read of dependency barrier | `{id, state, unblocked, success, pending, failed}`; exit 0 unblocked / 1 pending / nonzero on missing id |
| `tick` | Cascade unblock + reclaim stale claims | Run by factory; also a backstop |
| `spawn-ready [--pool X]` | List claimable tasks | |
| `hitl emit` | Emit a HITL prompt | See HITL verbs below |
| `hygiene-emit` | Emit a hygiene task | Auto-dedups |
| `compact` | Archive old terminal rows | |
| `vacuum` | GC stale deliverables, artifacts | |
| `doctor` | Diagnose schema/ledger health | |
| `render-prompt <id>` | Emit worker system prompt | |
| `print-claim-sql` | Emit the atomic claim SQL | Bash bootstrap only |

### `ledger hitl emit` flags

```
--class taste|impact       (required)
--kind ask_choice|ask_text|ask_confirm|notify|show_artifact  (required)
--prompt "<q>"            (required)
--option X                (repeatable; for ask_choice)
--recommended <val>      (required for class=taste)
--timeout-sec N           (for class=taste; forbidden for impact)
--divergence forward_fix|replay
--anchor-repo R --anchor-branch B --anchor-commit C
--emitted-by <id>
```

---

## TypeScript Exported Functions

### `src/ledger/claim.ts`

```ts
// Canonical atomic claim. One SQL UPDATE...RETURNING. No locks, no retries.
export function claimOnce(
  db: Database,
  worker: string,
  poolFilter?: string,
): { id: string } | null

// Exported SQL fragments for the bash bootstrap path.
// buildClaimSQL(true) emits the pool-filter variant.
export const CLAIM_SQL: string
export function buildClaimSQL(poolFilter: boolean): string
```

### `src/ledger/db.ts`

```ts
// Open WAL-mode SQLite. Default path from $ARC_LEDGER_DB or ~/vault/ledger.db.
export function open(path?: string): Database
export function openWithMigrate(path?: string): Database

// ID generation (slugified + collision-suffixed)
export function mintId(db: Database, title: string): string
export function shortId(): string
export function slugify(s: string): string
```

### `src/ledger/kinds.ts`

```ts
// Claimable kinds: the factory will claim rows with these kinds.
export const CLAIMABLE_KINDS = ["task", "event", "sprint"] as const
export type ClaimableKind = (typeof CLAIMABLE_KINDS)[number]

// Parked kinds: ready but intentionally non-claimable (product specs).
export const PARKED_KINDS = ["prd"] as const
export type ParkedKind = (typeof PARKED_KINDS)[number]

// SQL IN-fragments for composed queries.
export const CLAIMABLE_KINDS_SQL: string
export const PARKED_KINDS_SQL: string
```

### `src/ledger/tier-pool-sort.ts`

```ts
export type Tier = "tier_unset" | "tier_0" | "tier_1" | "tier_2" | "tier_3" | "hygiene"
export type Pool = "pool_unset" | "explore" | "interactive" | "prod" | "focus"

// Sort key for prioritized claim ordering.
// SQL: tier_rank DESC, pool_rank DESC, created_at ASC, id ASC
export const SORT_KEY_SQL: string
export const TIER_RANK_SQL: string
export const POOL_RANK_SQL: string
```

### `src/ledger/bookie-validator.ts`

```ts
export interface CreateInput {
  title?: string; kind?: string; type?: string
  body?: string; acceptance?: string; parent?: string
  blockedBy?: string; project?: string
  tier?: string; pool?: string
}

export function validateCreate(input: CreateInput, positional: string[]): ValidationError[]
export function validateDecompose(input: { parent: string; children: string[] }): ValidationError[]
export function validateStateTransition(cur: IssueState, next: IssueState): ValidationError[]
```

### `src/ledger/hitl-prompt.ts`

```ts
// Validate + construct a kind-specific payload object (Zod).
export function buildPayload(
  kind: HitlKind,
  args: BuildPayloadArgs,
): ValidatedPayload

export type BuildPayloadArgs = {
  prompt?: string; options?: string[]; message?: string
  level?: "info" | "warn" | "error"; caption?: string
  artifacts?: { type: string; inline?: string; path?: string }[]
}

// Atomic insert: prompt row + per-module delivery rows.
export function insertHitlPrompt(
  db: Database, input: InsertHitlPromptInput
): { id: string; deliveries: string[] }
```

### `src/ledger/ux-config.ts`

```ts
export type UxConfig = {
  modules: Record<string, UxModule>
}

export type UxModule = {
  name: string
  cli?: string
  pusher?: string
  implements: HitlKind[]
  renders: Record<ArtifactType, RenderStrategy>
  can_retract: boolean
}

// Load ~/.config/arc/config.yaml (or $ARC_CONFIG).
export function loadConfig(path?: string): UxConfig

// Modules with a recent heartbeat (300s).
export function aliveModuleNames(db: Database, staleSec?: number): string[]
```

### `src/ledger/schema-enums.ts`

```ts
export type Class = "taste" | "impact"
export type Urgency = "interactive" | "nominal" | "deferred"
export type Tier = /* as above */
export type Pool = /* as above */
```

### `src/worker/templates.ts`

```ts
export type RenderInput = {
  kind: string; agent: string; pool: string; worker: string
  task: string; thread_id?: string; thread_replay?: string
}

export function renderSystemPrompt(input: RenderInput): string
```

### `src/worker/thread-context.ts`

```ts
// Load prior chat turns for a thread (interviewer continuity on cold start).
export function loadThreadContext(
  db: Database, thread_id: string, current_task: string
): string
```

### `src/profiles/load.ts`

```ts
export type Profile = {
  context_files: string[]
  boot: string[]
  model?: string; budget?: number
}

export function loadProfile(agent: string, root?: string): Profile
export function loadAll(root?: string): Record<string, Profile>
```

### `src/interviewer/pre-drafter.ts`

```ts
export type ChatInRow = {
  id: string; thread_id: string; agent: string; created_at: number
  prompt: string; draft_md?: string
}

export type DraftPayload = {
  primary: string
  alternatives: string[]
}

export function selectTopChatIn(db: Database, n?: number): ChatInRow[]
export function runPreDrafter(db: Database, row: ChatInRow): RunResult
```

---

## Config Schema (`config.json` at repo root)

```json
{
  "exec_cli_alias": {
    "fast_alias": "claude {prompt}",
    "smart_alias": "claude --model opus-4.7 {prompt}"
  },
  "default_alias": "fast_alias",
  "pool_caps": {
    "interactive": 8,
    "prod": 4
  }
}
```

Each `exec_cli_alias` value must contain `{prompt}` exactly once.

---

## UX Module Config (`~/.config/arc/config.yaml`)

```yaml
modules:
  arc-tui:
    cli: ./bin/arc-tui.ts
    implements: [ask_choice, ask_text, ask_confirm, notify, show_artifact]
    renders:
      text/markdown: native
      chart/vega-lite: ascii-degrade
      diagram/mermaid: ascii-degrade
      image/png: rasterize-png
    can_retract: false
```

---

## Skills (bundled)

Skills live in `skills/`. Invoke them via the `/<name>` slash command in
the agent session.

| Skill | Description |
|---|---|
| `bookie` | Ledger write authority (create, update, decompose, event, hitl emit) |
| `ke-recall` | FTS5 search over `~/vault/ke/` knowledge entries |
| `ke-learn` | Write a knowledge entry to `~/vault/ke/<scope>/` |
| `claude-afk` | Headless-shaped `claude` invocation in a live tmux pane |
| `to-ledger` | Walk owner through filing a ledger row |
| `triage-failed` | Classify a failed row as auto-decomposable or needs-HITL |
| `spawn` | Decompose into child rows (wires blocked_by, flips blocked) |
| `diff-review` | Pre-commit diff review against task brief + ADRs |
| `deploy-preview` | Scan open PRs for deploy preview URLs |
| `improve-architecture` | Slice-bounded refactor (clarify boundaries, remove incidental complexity) |
| `analyse-recent-sessions` | Read worker scrollbacks, identify friction, write skill |
| `trash-retired-files` | Reversible file GC with semantic scope |
| `triage-assign` | Batch-claim + assign tier/pool/agent for unassigned rows |
| `sprint-supervise` | Re-entrant sprint loop for thin vertical slices |
| `spec-to-tickets` | Decompose a spec into sprint rows |
| `replay-shadow` | Replay a worker execution against a candidate config |

---

## Project Column

`project` is a free-form string on every issue row. Workers use `project=ke`
to indicate work scoped to the KE (Knowledge Engine) subsystem within the
broader arc-agents repo. The ledger does not enforce project values.