# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Canonical docs (read first)

- `CONTEXT.md` — domain glossary (Ledger, Issue, Worker, Factory, Interviewer, Bookie, Claim, Decomposition, Worktree, Reap). Definitions only.
- `CHOICES.md` — scoped decisions (M-* mission, A-* architecture, G-* design, S-* skills, D-* data, I-* implementation). Higher tier constrains lower.
- `PRD-v1.md` — product spec.
- `docs/adr/` — architecture decision records (when present).

Treat `CONTEXT.md` as a glossary, not a spec — do not put implementation details there. Use `CHOICES.md` for decisions, ADRs for hard-to-reverse trade-offs.

## Commands

Runtime is **Bun** (not Node). TypeScript throughout.

```
bun install                          # install deps
bun test                             # run all tests (bun's test runner)
bun test bin/ledger.test.ts          # single test file
bun test -t "claims atomically"      # filter by test name
bun run typecheck                    # tsc --noEmit
bun bin/ledger.ts <verb>             # invoke CLI without install
bin/merge-gate.sh                    # pipeline merge gate: fixture + typecheck + secret scan + bun test + write-lane (invariant 7, fail-closed)
bun bin/cron-install.ts install --dry-run --from <tab> bin/cron/*.cron  # upsert cron manifests as marker blocks
bun bin/cron-lint.ts [crontab-file]  # fail on unpinned-PATH bun/pi entries
```

CLI verbs (see `I-0001`): `init, create, claim, update, event, list, show, tick, spawn-ready, compact, vacuum`.

Install bins on PATH (only after merge to main, per `I-0005`):
```
bun link && bun link arc-agents      # registers ledger, wait-for-ledger
```

## Architecture (big picture)

**Ledger is the message bus.** SQLite at `~/vault/ledger.db` with two tables: `issues` and `issue_events` (append-only). Every state change is an atomic SQL transition. No daemons, no IPC, no queues — just rows.

**Three runtime actors:**
- **Interviewer** — ephemeral, same factory pool as workers (ADR 0003). User posts via `bin/arc-chat.ts post <msg>`; the factory's fast-pass slot claims the resulting `chat_in` row and the worker (frame=intake, skills=grill-with-docs+choose-wisely+ke-recall) emits a `chat_out` reply tagged with the same `thread_id`. `bin/arc-chat.ts tail --thread T` streams replies.
- **Workers** — ephemeral tmux sessions (`arc-worker-<rand>`). Each = one task = one `claude` process. Booted by `bin/worker-shell.sh`, which performs the atomic claim in bash then `exec`s interactive `claude`. The claim is the *only* ledger write that bypasses the bookie.
- **Factory** — supervisor daemon (`bin/factory.ts`). Reaps workers >4hr old, spawns fresh ones up to N=4 when ready tasks exist. Always-on.

**Bookie subagent** (`.claude/agents/bookie.md`) is the sole authority for ledger *writes* inside an agent session. Workers and the interviewer delegate all writes via the Agent tool. Reads bypass the bookie.

**Issue lifecycle:** `ready → claimed → wip → review → merged` (or `→ blocked / failed / cancelled`). `merged` and `cancelled` are terminal. Cascade-on-merge: a SQL trigger flips dependents `blocked → ready` when all blockers merge; `ledger tick` is the polling backstop.

**Decomposition:** an AFK worker that hits a blocker only a human can resolve atomically inserts N HITL children + sets `parent.blocked_by=[childIds]` + flips parent to `blocked`. Fanout cap = 5, recursion allowed.

## Layout

```
bin/        executables (ledger, factory, arc-chat, worker-shell.sh, wait-for-ledger)
src/        library code (ledger/, profiles/)
profiles/   role JSON (developer, director, admin) — context, boot skills, model, budget, concurrency
skills/     skill definitions (bookie, ke-recall, ke-learn, claude-afk, to-ledger, triage-failed)
hooks/      claude hooks (session-start, stop, session-end, pre-tool-use)
system/     system-level docs
contexts/   per-bounded-context glossaries (CONTEXT.md each), when multi-context
.private/   gitignored local state
```

External state: `~/vault/ledger.db` (canon), `~/vault/ke/` (knowledge engine), `~/vault/agents/<role>/` (memory, inbox, journal, outbox), `~/worktrees/<repo>-<slug>/` (worker scratch).

## Role selection (`A-0003`, superseded)

Cwd-based vault-path role inference is retired — `src/profiles/select-by-cwd.ts`
removed. An agent is invoked directly against a repo's root path; that repo's
own `AGENTS.md` (bindings, worker roles, constraints) is the context, not a
`~/vault/agents/<role>/` cwd match. See `CHOICES.md` `A-0003`.

## Hard constraints

- **Interactive panes only** (`M-0002`). No `claude -p` headless subprocesses — transparency/observability driven (live attachable tmux panes, full scrollback); Max-bucket billing is a side benefit.
- **Atomic claim** (`G-0002`). One SQL `UPDATE...RETURNING` decides the winner. Don't add locks or retry loops.
- **All writes through bookie** except the bootstrap claim in `worker-shell.sh`.
- **No symlinks during migrations** (`G-0007`). Move files; let subagents fix refs.
- **Vault overrides repo** (`A-0004`) where both exist. Vault never pushed.
- **TypeScript default** (`G-0008`), Bun runtime.
- **Two-tier model policy** (`G-0006`): Opus 4.7 for synthesis (≤$10/day), minimax-m2.7 for implementation (direct API).
- **Commit author** is whatever `git config user.name` / `user.email` resolve to (`I-0006`). No hardcoded usernames.
- **One slice per worktree per commit** (`G-0005`), 100k token smart-zone cap.

## AFK shutdown (workers)

Before exiting, drive the task to terminal: either `merged` (with evidence + PR) or `failed` (with evidence), or `decompose` into HITL children (state=blocked). The `hooks/stop.sh` Stop hook reminds — it does not enforce. Commit as the configured git user, remove the worktree.
