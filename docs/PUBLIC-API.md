# Public API

> **Status: pre-alpha.** Surface will break without notice.

This document records the stable public surface — the parts that will be
preserved across SemVer bumps once a `1.0.0` is reached. Everything else is
internal and may change arbitrarily.

---

## Version pinning policy

This package targets `0.x.y` pre-alpha. Pin strategy:

- `package.json` `version` field: **exact** (no `^`, no `~`).  
  `bun install` locks exact versions into `bun.lock`.  
  A bump is required for every change, making the SemVer contract explicit.
- `devDependencies` / `dependencies`: caret-pinned (`^major.minor`) is
  acceptable during the pre-alpha phase; they are dev-facing only.

---

## CLI commands (`bin/`)

All entrypoints require `bun` and are invoked as `bun ./bin/<name>.ts` or via
the registered bin aliases after `bun link && bun link arc-agents`.

| Bin | Purpose |
|-----|---------|
| `ledger` | Ledger CLI — all verbs for issue lifecycle management |
| `factory` | Supervisor daemon — spawns/reaps ephemeral worker tmux sessions |
| `arc-chat` | Interviewer: post user messages, stream replies via thread ID |
| `arc-ux` | UX module shim — dispatches to configured render strategies |
| `arc-tui` | Reference UX module: `heartbeat | list | answer` strategies |
| `arc-replay` | Shadow-replay tool for config/prompt regression testing |
| `webui-server` | HTTP server for arc-webui two-panel HITL+AFK surface |
| `wait-for-ledger` | Blocking script: spins until `ledger init` succeeds |

### `ledger` verbs

All flags, no positional args (per PRD-v1 §4).

| Verb | Description |
|------|-------------|
| `init` | Bootstrap the SQLite WAL database + apply migrations |
| `create` | Create a new issue; all fields via flags |
| `claim` | Atomic `UPDATE ... RETURNING` — claim one `ready` task |
| `update` | Update an issue's state, title, body, etc. |
| `event` | Append an append-only event record to an issue |
| `list` | List issues; filter by `--state`, `--pool`, `--agent`, `--project` |
| `show` | Emit full issue record + event log as JSON |
| `tick` | Factory-side tick: spawn-ready, sweep stale claims, cascade-on-merge |
| `spawn-ready` | Find all `blocked` issues whose blockers are all `merged`; flip to `ready` |
| `compact` | Vacuum + WAL checkpoint |
| `vacuum` | `VACUUM` the SQLite database |

---

## Library exports (`src/`)

Only the following entrypoints are public. Import via relative path from
the source tree; no npm package or CDN export yet.

### `src/ledger/kinds.ts`

```typescript
export const KIND_VALUES = ["prd", "task", "hitl_prompt", "chat_in", "chat_out", "blog", "note", "hygiene", "event"] as const;
export type IssueKind = typeof KIND_VALUES[number];

export const CLAIMABLE_KINDS_SQL: string; // SQL fragment
export function assertKind(v: unknown): asserts v is IssueKind;
export function isClaimableKind(k: IssueKind): boolean;
```

### `src/ledger/claim.ts`

```typescript
export const CLAIM_SQL: string; // full atomic claim SQL
export function buildClaimSQL(agent: string, pool?: string, worktree_path?: string): string;
export async function claimOnce(db: Database, agent: string, pool?: string, worktree_path?: string): Promise<string | null>;
```

### `src/ledger/bookie-validator.ts`

```typescript
export function validateCreate(raw: unknown): CreateInput;
export function validateStateTransition(cur: string, next: string): void;
export function validateDecompose(raw: unknown): DecomposeInput;
export const TIER_VALUES: readonly string[];
export const POOL_VALUES: readonly string[];
export const AGENT_VALUES: readonly string[];
export const STATE_VALUES: readonly string[];
```

### `src/ledger/db.ts`

```typescript
export function open(path?: string): Database;
export function openWithMigrate(path?: string): Database;
export function mintId(): string;
```

### `src/config/load.ts`

```typescript
export const ConfigSchema: ZodSchema; // validates config.json
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(root?: string): Config;
export function resolveAlias(aliasName: string, cfg: Config): string;
export function resolveFast(cfg: Config): { alias: string; command: string };
export function resolveSmart(cfg: Config): { alias: string; command: string };
```

### `src/profiles/load.ts`

```typescript
export const ProfileSchema: ZodSchema;
export type Profile = z.infer<typeof ProfileSchema>;
export function loadProfile(agent: string, root?: string): Profile;
export function loadAll(root?: string): Record<string, Profile>;
```

---

## Config schema (`config.json`)

Written by the `/select-models` skill. Schema validated by `ConfigSchema`
(`src/config/load.ts`).

```typescript
{
  exec_cli_alias: Record<string, string>,  // e.g. { "fast": "claude --model haiku {prompt}" }
  default_alias: string,                   // key into exec_cli_alias
  pool_caps: Record<string, number>,       // e.g. { "explore": 3, "build": 2 }
  fast_alias?: string,                     // key into exec_cli_alias
  smart_alias?: string,                    // key into exec_cli_alias
}
```

Rules:
- Each alias command must contain `{prompt}` exactly once.
- An alias using `claude --model` must name a known Claude model (`opus`,
  `sonnet`, `haiku`). Provider models (e.g. `minimax-m2.7`) must use
  `pi -p --provider` instead.

---

## Profiles (`profiles/`)

Agent role profiles, loaded by `src/profiles/load.ts`.

| File | Role |
|------|------|
| `developer.json` | Default build/test/implement role |
| `director.json` | CHOICES steward, user communication |
| `admin.json` | Infrastructure, credential rotation |
| `sprint.json` | Tracer-bullet slice driver |
| `triage.json` | Batch classification of incoming issues |

Each profile contains: `agent`, `context_summary`, `context_files`,
`boot_skills`, `stop_skills`, `exec_cli_alias`, `max_concurrency`,
`worktree`.

---

## Architecture Decision Records (`docs/adr/`)

| ADR | Subject |
|-----|---------|
| 0001 | Ephemeral workers (tmux-based, no `claude -p`) |
| 0002 | UX module contract |
| 0003 | Ephemeral interviewer |
| 0004 | Agent doctrine |
| 0005 | Ledger schema PRD-v1 |
| 0006 | Deliveries module |

---

## What is NOT public API

- Any file under `src/worker/`, `src/interviewer/` — internal harness machinery
- `src/ledger/hitl-*.ts` — HITL subsystem, subject to redesign
- `src/ledger/worktree-*.ts` — worktree lifecycle, internal to factory
- `src/ledger/deploy-preview.ts` — probe cron, not user-facing
- `src/ledger/failed-classifier.ts` — hygiene logic, internal
- `src/ledger/hygiene-*.ts` — hygiene subsystem, internal
- `src/ledger/tier-pool-sort.ts` — internal queue ordering
- All contents of `.claude/` and `.private/` directories