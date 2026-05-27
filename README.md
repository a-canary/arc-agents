# arc-agents

> **Status: WIP / pre-alpha.** Personal research harness, evolving in public.
> APIs, schemas, and CLIs will break without notice. Not packaged for external
> use yet — clone and read if curious; expect rough edges. Assumes a specific
> `~/vault/`, `~/worktrees/`, `~/.config/arc/` layout on the host.

---

## What it is

**arc-agents** is a universal agent harness. A SQLite ledger at `~/vault/ledger.db` is the message bus. Every unit of work — tasks, chat messages, HITL prompts — is a row. Every state transition is an atomic SQL commit. No daemons, no IPC sockets, no queues — just rows.

The dispatch runtime is **always-on interactive `claude` panes**: every worker is a live tmux session you can attach to, watch tool use in real time, and inspect via scrollback. This is the primary design decision (M-0002). Side benefit: interactive panes bill against the Max Claude-Code bucket rather than the extra-usage API bucket.

Three roles, one codebase:

| Role | Scope | Workspace |
|---|---|---|
| **Director** | Portfolio strategy, CHOICES alignment, user comms | `~/vault/agents/director/` |
| **Developer** | Code execution per repo CHOICES, spawned per worktree | `~/worktrees/<repo>-<slug>/` |
| **Admin** | System, secrets, security, billing | `~/vault/agents/admin/` |

See [CONTEXT.md](./CONTEXT.md) for the domain glossary — all terms used in this README are defined there.

## Stack

Bun + TypeScript. SQLite via `bun:sqlite`. zod for schemas. yaml for config.

No runtime dependencies beyond Bun. No external services.

## Quickstart

```bash
bun install
bun test
bun bin/ledger.ts init   # creates ~/vault/ledger.db
bun bin/factory.ts       # supervisor daemon — keep running
```

Install bins on PATH (after merge to main):

```bash
bun link && bun link arc-agents  # registers: ledger, wait-for-ledger
```

## Architecture sketch

```
┌─────────────────────────────────────────────┐
│  ~/vault/ledger.db  (SQLite WAL)            │
│  2 tables: issues + issue_events            │
└──────────┬──────────────────────────────────┘
           │ SQL
┌──────────▼──────────────────────────────────┐
│  bin/factory.ts   Supervisor daemon          │
│  • reaps workers >4hr                        │
│  • spawns ≤4 ephemeral tmux workers          │
│  • fast-pass pool for interactive chat        │
└──────────┬──────────────────────────────────┘
           │ spawn: bash bin/worker-shell.sh <id>
           ▼
┌─────────────────────────────────────────────┐
│  bin/worker-shell.sh                        │
│  1. atomic claim (UPDATE...RETURNING)        │
│  2. exec claude (interactive pane)           │
└─────────────────────────────────────────────┘
           │
           ▼  "all writes through bookie"
┌─────────────────────────────────────────────┐
│  .claude/agents/bookie.md                    │
│  Sole authority for ledger writes            │
│  Validates: kind, type, state, module refs   │
└─────────────────────────────────────────────┘

UX Module Contract (ADR 0002):
┌──────────────────────────────────────────────┐
│  .claude/agents/arc-ux   HITL shim           │
│  hitl_prompts + hitl_deliveries tables        │
│  First-reply-wins via atomic UPDATE          │
└──────────┬───────────────────────────────────┘
           │ render/retract per module
           ▼
    arc-tui · arc-webui · arc-discord  (pluggable)
```

**Ledger read path** (list, show, tick): direct SQL, no bookie.
**Ledger write path** (create, update, event, decompose): via bookie subagent.

## Phase summary

### Shipped (v1)

- [x] **Ledger core** — `issues` + `issue_events` tables, atomic claim
      (`UPDATE ... RETURNING` race-free by construction), cascade-on-merge
      SQL trigger flips dependents `blocked → ready`.
- [x] **CLI** — `ledger {init,create,claim,update,event,list,show,tick,
      spawn-ready,compact,vacuum}`. Flag-only `create` per PRD-v1 §4.
- [x] **Bookie validator** — single authority for ledger writes inside an
      agent session. Subagent at `.claude/agents/bookie.md`.
- [x] **Factory** — supervisor daemon: reaps workers >4hr, spawns up to
      N=4 ephemeral tmux sessions from ready queue, sweeps orphan claims.
- [x] **HITL schema** — `hitl_prompts` + `hitl_deliveries` tables, two-table
      model matching `issues` + `issue_events`. First-reply-wins atomic UPDATE
      on `state`; loser deliveries cascade to `retracted` via SQL trigger.
- [x] **UX Module Contract (ADR 0002)** — `arc-ux` verb shim, config-declared
      verbs + render strategies, liveness via ledger heartbeats. `arc-tui` as
      reference module (`heartbeat | list | answer`).
- [x] **Hygiene cron** — `bin/hygiene-tick.ts`: round-robin repo list, one
      `kind=event, class=ops` task per tick, skip-not-stack semantics.
- [x] **Skills** — `bookie`, `ke-recall`, `ke-learn`, `claude-afk`,
      `to-ledger`, `to-prd`, `prd-to-issues`, `diff-review`,
      `triage-failed`, `analyse-recent-sessions`.
- [x] **arc-webui** — SvelteKit scaffold, two-panel HITL+AFK web surface
      (see [`PRD-arc-webui.md`](./PRD-arc-webui.md) +
      [`SLICE-PLAN-arc-webui.md`](./SLICE-PLAN-arc-webui.md)).

### In progress

- [ ] **arc-discord** — async push module for HITL prompts via Discord bot.
- [ ] **Render strategies beyond `native`/`ascii-degrade`** —
      `rasterize-png`, `link-out` for non-graphical surfaces.
- [ ] **Decomposition flow** — AFK workers atomically insert N HITL
      children + flip parent to `blocked`; fanout cap = 5, recursion ok.
- [ ] **Impact-class HITL backpressure** — interviewer-only gate on
      `class=impact` prompts; workers must decompose instead.

### Backlog

- [ ] **Public packaging** — split into installable plugin + bootstrap
      interview; today assumes the host's `~/vault/`, `~/worktrees/`,
      `~/.config/arc/` layout.
- [ ] **Contributor guide** — runnable dev setup, ADR index.
- [ ] **Per-worktree compaction** — drop or summarize old chat turns to
      bound thread-replay token cost.

## Document map

| File | What it is |
|---|---|
| [`CONTEXT.md`](./CONTEXT.md) | Domain glossary. Read first. |
| [`CHOICES.md`](./CHOICES.md) | Scoped decisions (M/A/G/S/D/I tiered). |
| [`PRD-v1.md`](./PRD-v1.md) | Product specification. |
| [`PRD-arc-webui.md`](./PRD-arc-webui.md) | Web UI slice spec. |
| [`docs/adr/`](./docs/adr/) | Architecture decision records. |
| [`roles/AGENTS.md`](./roles/AGENTS.md) | Agent doctrine (evidence-first, concern→HITL, etc.). |
| [`skills/`](./skills/) | Skill definitions. |

## Layout

```
bin/           executable entrypoints (ledger, factory, arc-chat, arc-ux,
               arc-tui, hygiene-tick, webui-server, …)
src/           library code (ledger/, profiles/, config/, worker/, interviewer/)
profiles/      role JSON (developer, director, admin)
skills/        skill definitions
docs/adr/      architecture decisions
roles/         agent doctrine + frame templates (AGENTS.md, frames/)
contexts/      per-bounded-context glossaries (CONTEXT.md per domain)
.private/      gitignored local state
```

External state (not in repo):

```
~/vault/ledger.db          canonical ledger
~/vault/ke/                knowledge engine (FTS5 + Qdrant)
~/vault/agents/<role>/     memory, inbox, journal, outbox per role
~/worktrees/<repo>-<slug>/ per-task worktree scratch
~/.config/arc/config.yaml UX module declarations
```

## Hard constraints

- **Interactive panes only** — no `claude -p` headless subprocesses
  (`M-0002`, billing-driven).
- **Atomic claim** — one SQL `UPDATE ... RETURNING` decides every race;
  no locks, no retry loops (`G-0002`).
- **All writes through bookie** (`I-0003`) — except the bootstrap claim
  in `worker-shell.sh` (documented exception).
- **Vault overrides repo** (`A-0004`) where both exist; vault never pushed.
- **TypeScript default** (`G-0008`), Bun runtime.

## License

MIT — see [`LICENSE`](./LICENSE).
