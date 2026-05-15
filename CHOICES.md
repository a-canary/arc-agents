# arc-agents — CHOICES

Project-scope decisions. System-level decisions live in `~/arc-agents/system/CHOICES.md` (post-migration). Higher constrains lower.

---

## Mission

### M-0001: Ledger-Dispatched Agent Harness
SQLite ledger at `~/vault/ledger.db` is the message bus. No daemons, no IPC. State transitions are atomic SQL.

### M-0002: Interactive Panes Only
Runtime is always-on `claude` panes. No headless `claude -p` subprocesses (billing constraint).

### M-0003: Universal Across CLI Runtimes
Primary: claude code. Adapters: pi, qwen, opencode. Agents defined once.

### M-0004: Ephemeral Workers via Factory
Workers are one-shot tmux sessions, not long-lived panes. `bin/factory.ts` supervises: reaps sessions older than 4hr, spawns fresh `bash worker-shell.sh` (which atomically claims one task then `exec`s interactive `claude`) up to N=4 concurrent. Session dies on completion → next tick respawns if more work. Eliminates context pollution and stale-code drift. Compatible with M-0002 — workers remain interactive `claude` invocations (positional prompt, no `-p`).

---

## Architecture

### A-0001: Three-Tier Layout
`~/repos/` (canonical) · `~/worktrees/<repo>-<slug>/` (dev) · `~/vault/` (portfolio state) · `<repo>/.private/` (gitignored local).

### A-0002: Three Roles
Director (portfolio, user comms) · Developer (per-worktree code) · Admin (system, secrets).

### A-0003: Agent Selection by CWD
1. `~/vault/agents/admin/` → Admin
2. `~/vault/agents/director/` → Director
3. `~/worktrees/<repo>-*/` → Developer
4. `~/repos/<name>/` → Developer (read-mostly)
5. fallback → Director

### A-0004: Vault Overrides Repo
Private wins where both exist. Vault never pushed.

### A-0005: arc- Prefix
User-owned repos prefixed `arc-`. Third-party keeps upstream name.

---

## Design

### G-0001: Ledger Schema is Canon
`issues` + `issue_events`. `kind`, `type`, `state`, `blocked_by`, `thread_id` fields. `kind`/`type`/`state` are CHECK-constrained enums (migration 008). Schema changes require CHOICES update.

### G-0002: Atomic Claim
Workers claim via single SQL `UPDATE...RETURNING`. No race conditions, no advisory locks.

### G-0003: Cascade-on-Merge
SQL trigger flips dependents `blocked` → `ready` when all blockers merged. Polling backstop via `ledger tick`.

### G-0004: Slug-Primary Worktree Naming
`<repo>-<slug>`. Collision → append `-<xxxx>`. LLMs reason better on semantic slugs.

### G-0005: One Slice Per Worktree Per Commit
Thin vertical tracer-bullets. 100k token smart-zone cap per issue.

### G-0006: Two-Tier Model Policy
Opus 4.7 for synthesis ($10/day cap). minimax-m2.7 for impl (unlimited, direct API).

### G-0007: No Symlinks During Migrations
Move files; subagents fix refs.

### G-0008: TypeScript Default
TS over Python where reasonable. Bun runtime.

---

## Skills

### S-0001: Mandatory Skills
`ke-recall` (start) · `ke-learn` (stop, queued) · `spawn` (ledger write, not process spawn).

### S-0002: Skills Location
`~/repos/arc-agents/skills/`.

---

## Data

### D-0001: Ledger
`~/vault/ledger.db` — SQLite WAL.

### D-0002: Knowledge Engine
`~/vault/ke/` — FTS5 + Qdrant. Deprecated `~/kb/`.

### D-0003: Per-Role State
`~/vault/agents/<role>/` — memory.md, inbox/, journal/, outbox/.

### D-0004: Scratch
`~/vault/scratch/<slug>/` — prototype outputs. Not in `~/repos/` or `~/worktrees/`.

---

## Implementation

### I-0001: CLI Surface
`ledger` binary (TS, bun). Verbs: init, create, claim, update, event, list, show, tick, spawn-ready, compact, vacuum.

### I-0002: Launcher + Factory
`bin/launch.ts` — single-pane interviewer tmux session `arc`. `bin/factory.ts` — supervisor daemon spawning ephemeral worker sessions (see M-0004). `bin/worker-shell.sh` — bootstrap: atomic claim → exec interactive `claude`.

### I-0003: Bookie Subagent
Writes ledger rows on behalf of agents. Single point of validation.

### I-0004: Profiles
`profiles/<role>.json` — context_summary, boot_skills, model, daily_budget_usd, max_concurrency, worktree.

### I-0005: Install via bun link
`bun link` from `~/repos/arc-agents/` → `~/.local/bin/{ledger,agent}`. Only after merge to main.

### I-0006: Git Author
Commits as `a-canary <noreply>`.
