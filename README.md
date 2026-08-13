# arc-agents

> **Status: early-access.** APIs, schemas, and CLIs may break between releases.
> Designed for single-operator (aaron) on one host — not yet packaged for
> external use. Clone and read if curious.

**Related repos:**
- [a-canary/arc-skills](https://github.com/a-canary/arc-skills) — zero-dependency skills (incl. `/director`, `/task`, `/qa`, `/feedback`) that can drive this harness or run standalone via flat files
- [a-canary/webui](https://github.com/a-canary/webui) — developer portal/dashboard that reads this repo's ledger

Universal agent harness. **SQLite ledger as the message bus.** Every unit of
work — task, chat, human-in-the-loop prompt — is a row. State transitions are
atomic SQL. No daemons, no IPC, no queues — just the ledger.

Workers are ephemeral `claude` sessions (interactive panes, not headless
processes). Each worker boots into its own git worktree, claims one task,
executes, and exits. The factory daemon supervises: reaps stale sessions,
spawns fresh ones when work is ready.

See [`CONTEXT.md`](./CONTEXT.md) glossary, [`CHOICES.md`](./CHOICES.md)
scoped decisions, [`PRD-v1.md`](./PRD-v1.md) product spec, and
[`docs/adr/`](./docs/adr/) for architecture decisions.

---

## Architecture

```
User (Discord IRC) ──► arc-chat.ts ──► ledger ──► interviewer (claude pane)
                                                    │
                                              hitl_prompts
                                                    │
                          UX modules ◄──────────────┘
                         (arc-webui, arc-tui, …)

Factory daemon ──► worker-shell.sh ──► worker (claude pane) ──► ledger
     │                      atomic claim (no bookie)
     │◄─────────────────── reaps stale sessions (4hr+ old)
     │
     └───────────────────── spawns fresh workers up to N=4 concurrent
```

### Core concepts

| Concept | What it is |
|---|---|
| **Ledger** | `~/vault/ledger.db` — SQLite WAL. Two tables: `issues` + `issue_events`. Single source of truth for all work. |
| **Issue** | A row in the ledger. `kind` = task / event / reply. `state` = ready → claimed → wip → review → merged (terminal). |
| **Worker** | Ephemeral `claude` session in a tmux pane. One task → one worker → one worktree. Exits when done. |
| **Factory** | Always-on supervisor daemon. Reaps stale tmux sessions, spawns fresh workers. |
| **Bookie** | Subagent that validates and routes all ledger writes inside a worker session. |
| **Interviewer** | Ephemeral `claude` pane spawned by factory for new chat threads. Owns Intake (UX_1) and HITL prompts (UX_2). |
| **Worktree** | Git working copy at `~/worktrees/<repo>-<slug>/`. One per task. Removed on completion. |

### HITL (Human-In-The-Loop)

Tasks that need a human decision emit rows to `hitl_prompts`. UX modules
(TUI, webui, Discord) surface the prompt to the user. First reply wins;
losing deliveries retract via SQL cascade.

- **Taste** — 60s timeout, recommended answer, dependent work proceeds speculatively. Workers can emit directly.
- **Impact** — no timeout, blocks dependents. Requires interviewer (not worker).

### Model policy

Two tiers: **Opus 4.7** for synthesis and design reasoning (hard $10/day cap).
**minimax-m2.7** for bulk implementation (unlimited, direct API).

---

## Install

```bash
git clone git@github.com:a-canary/arc-agents.git
cd arc-agents
bun install
```

Initialize the ledger (first time only):

```bash
bun bin/ledger.ts init
```

Run the factory:

```bash
bun bin/factory.ts
```

Create your first task:

```bash
bun bin/ledger.ts create task a-title "A description"
```

List ready tasks:

```bash
bun bin/ledger.ts list --state ready
```

Show a task:

```bash
bun bin/ledger.ts show <id-or-slug>
```

Update state or add events:

```bash
bun bin/ledger.ts update <id> --state merged --evidence "Done, PR ready"
bun bin/ledger.ts event <id> note "Follow-up filed as arc-agents-foo"
```

Install bins on PATH (after merge to main):

```bash
bun link && bun link arc-agents
```

Registers `ledger` and `wait-for-ledger` commands.

---

## Test

```bash
bun test
bun run typecheck
```

Run the merge gate:

```bash
./bin/merge-gate.sh
```

---

## Project layout

```
bin/          CLI entrypoints (ledger, factory, arc-chat, arc-ux, arc-tui, estate-secret-inventory, …)
src/          library code (ledger/, profiles/)
profiles/     role JSON (developer, director, admin) — context, boot skills, model
skills/       skill definitions (bookie, ke-recall, ke-learn, spawn, …)
docs/adr/     architecture decision records
```

External state — not in the repo:

```
~/vault/ledger.db     ← the ledger
~/vault/ke/           ← knowledge engine (FTS5 + Qdrant)
~/vault/agents/<role>/  ← per-role memory, inbox, journal, outbox
~/worktrees/<repo>-<slug>/  ← worker scratch (one per task)
~/.config/arc/       ← UX module config
```

---

## Status

### Shipped

- [x] Ledger core (`issues` + `issue_events`, atomic UPDATE…RETURNING claim,
      cascade-on-merge trigger)
- [x] CLI (`ledger {init,create,claim,update,event,list,show,tick,…}`)
- [x] Bookie validator (sole authority for ledger writes inside agent sessions)
- [x] Factory (supervisor: reaps stale workers, spawns up to N=4 ephemeral
      tmux sessions for ready tasks)
- [x] HITL schema (two-table: `hitl_prompts` + `hitl_deliveries`,
      first-reply-wins, SQL-cascade retract)
- [x] UX Module Contract (ADR 0002 — template pattern, pluggable modules)
- [x] arc-tui and arc-webui reference implementations
- [x] Hygiene cron (`bin/hygiene-tick.ts`)
- [x] Skills (bookie, ke-recall, ke-learn, claude-afk, spawn, to-ledger,
      triage-failed, diff-review)

### Coming soon

- [ ] `arc-discord` — async pusher for HITL prompts
- [ ] Decomposition flow (workers write HITL children + flip parent to blocked)
- [ ] Public packaging (bootstrap + installable plugin)
- [ ] Full contributor guide

---

## Key docs

- [`CONTEXT.md`](./CONTEXT.md) — domain glossary (Ledger, Issue, Worker,
  Factory, Bookie, HITL, …)
- [`CHOICES.md`](./CHOICES.md) — scoped decisions (M–mission, A–arch,
  G–design, S–skills, D–data, I–implementation)
- [`PRD-v1.md`](./PRD-v1.md) — product spec
- [`PRD-arc-webui.md`](./PRD-arc-webui.md) — webui slice spec
- [`docs/adr/`](./docs/adr/) — architecture decision records

---

## License

MIT — see [`LICENSE`](./LICENSE).
