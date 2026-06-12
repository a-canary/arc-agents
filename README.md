# arc-agents

> **Status: WIP / pre-alpha.** Personal research harness, evolving in public.
> APIs, schemas, and CLIs will break without notice. Not packaged for external
> use yet — clone and read if curious; expect rough edges. Assumes a specific
> `~/vault/`, `~/worktrees/`, `~/.config/arc/` layout on the host.

Universal agent harness. SQLite ledger + small CLI shims for running ephemeral
Claude Code workers off a shared message bus. Every state change is an atomic
SQL transition: no daemons, no IPC, no queues — just rows.

See [`CONTEXT.md`](./CONTEXT.md) glossary, [`CHOICES.md`](./CHOICES.md) scoped
decisions, [`PRD-v1.md`](./PRD-v1.md) product spec, and
[`docs/adr/`](./docs/adr/) for architecture decisions.

## Stack

Bun + TypeScript. SQLite via `bun:sqlite`. zod for schemas. yaml for config.

## Quickstart

```
bun install
bun test
bun bin/ledger.ts init
bun bin/factory.ts
```

> **Agents setting this up on a fresh or non-Linux host (Windows/macOS):** after
> `bun install`, run the smoke test below before anything else. It is the
> fastest signal that the harness can actually claim and isolate a task on this
> OS. If it fails, fix the cause (PATH resolution, worktree paths, and shell
> assumptions are the usual cross-platform culprits) and — if the fix belongs in
> the install steps or scripts — open a PR so the next host doesn't hit it.
>
> ```
> bun test bin/worker-shell-repo.test.ts   # repo routing + `pi` PATH resolution
> ```

Install bins on PATH (after merge to main):

```
bun link && bun link arc-agents     # registers ledger, wait-for-ledger
```

## Shipped

- [x] **Ledger core** — `issues` + `issue_events` tables, atomic claim
      (`UPDATE ... RETURNING`), cascade-on-merge SQL trigger.
- [x] **CLI** — `ledger {init,create,claim,update,event,list,show,tick,…}`,
      flag-only `create` per PRD-v1 §4.
- [x] **Bookie validator** — single authority for ledger writes inside an
      agent session; subagent at `.claude/agents/bookie.md`.
- [x] **Factory** — supervisor daemon: reaps workers >4hr old, spawns up to
      N=4 ephemeral tmux worker sessions when ready tasks exist; sweeps
      stale claims each tick.
- [x] **HITL schema** — two-table model (`hitl_prompts` + `hitl_deliveries`
      + `ux_heartbeats`); first-reply-wins atomic update; loser deliveries
      cascade to `retracted` via SQL trigger.
- [x] **UX Module Contract (ADR 0002)** — `arc-ux` verb shim,
      config-declared verbs + render strategies joined with ledger
      heartbeats for liveness, `arc-tui` reference module
      (`heartbeat | list | answer`).
- [x] **Hygiene cron** — `bin/hygiene-tick.ts`: round-robin repo list,
      one `type=cron` task per tick, skip-not-stack semantics, optional
      per-(repo, skill) cooldown via the `cadence` key in
      `~/.config/arc/hygiene.yaml`.
- [x] **Skills** — `bookie`, `ke-recall`, `ke-learn`, `claude-afk`,
      `to-ledger`, `triage-failed`.

## Coming soon

- [ ] **arc-webui** — 2-panel HITL+AFK web surface (see
      [`PRD-arc-webui.md`](./PRD-arc-webui.md) +
      [`SLICE-PLAN-arc-webui.md`](./SLICE-PLAN-arc-webui.md)).
- [ ] **arc-discord** — async push module for HITL prompts.
- [ ] **Decomposition flow** — AFK workers atomically insert N HITL
      children + flip parent to `blocked`; fanout cap = 5, recursion ok.
- [ ] **Render strategies beyond `native`/`ascii-degrade`** —
      `rasterize-png`, `link-out` for non-graphical surfaces.
- [ ] **Impact-class HITL backpressure** — interviewer-only gate on
      `class=impact` prompts; workers must decompose instead.
- [ ] **Public packaging** — split into installable plugin + bootstrap
      interview; today everything assumes the host's `~/vault/`,
      `~/worktrees/`, `~/.config/arc/` layout.
- [ ] **Docs pass** — runnable quickstart, contributor guide, ADR index.

## Layout

```
bin/         executable entrypoints (ledger, factory, arc-chat, arc-ux, arc-tui, hygiene-tick, …)
src/        library code (ledger/, profiles/)
profiles/   role JSON (developer, director, admin)
skills/     skill definitions
docs/adr/   architecture decisions
.private/   gitignored local state
```

External state: `~/vault/ledger.db` (canon), `~/vault/ke/` (knowledge engine),
`~/vault/agents/<role>/` (memory, inbox, journal, outbox),
`~/worktrees/<repo>-<slug>/` (worker scratch).

## Hard constraints (excerpted from `CHOICES.md`)

- Interactive Claude panes only — no `claude -p` headless subprocesses
  (`M-0002`, billing-driven).
- One SQL `UPDATE ... RETURNING` decides every race — no locks, no retry
  loops (`G-0002`).
- All ledger writes route through the bookie subagent, except the
  bootstrap claim in `worker-shell.sh`.
- No symlinks during migrations (`G-0007`); move files, fix refs.
- Vault overrides repo where both exist; vault never pushed (`A-0004`).
- TypeScript default (`G-0008`), Bun runtime.

## License

MIT — see [`LICENSE`](./LICENSE).
