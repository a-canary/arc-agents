# ADR 0001 — Ephemeral Workers via Factory

**Status:** Accepted — 2026-05-15
**Supersedes:** the original CHOICES.md I-0002 ("4-pane tmux launcher with `claude /loop 5m` workers"). See CHOICES.md M-0004.

## Context

The first arc-agents runtime ran four panes in a single tmux session: one interviewer + three workers. Each worker was a long-lived `claude` instance running `/loop 5m` and polling the ledger for claimable tasks via `wait-for-ledger.ts`.

Two problems showed up immediately:

1. **Context pollution.** A worker that finished task A carried task A's context (files read, tools invoked, conclusions reached) into task B. The model's behavior on B was measurably worse — anchored on A's framing, sometimes referencing A's files as if they were part of B's worktree.
2. **Stale code.** Workers never restarted, so updates to skills, hooks, subagent definitions, or worker prompts didn't take effect until the user manually killed and relaunched the session. The whole `~/repos/arc-agents` checkout could drift relative to what the running workers had loaded.

No human ever attended these sessions (workers are AFK by design). So the "interactive" framing was paid for in context-correctness without the corresponding observability benefit.

## Decision

Replace long-lived worker panes with **ephemeral worker sessions** supervised by a factory daemon.

- `bin/factory.ts` is the supervisor. Every `ARC_FACTORY_INTERVAL` seconds it:
  - Reaps tmux sessions matching `arc-worker-*` older than `ARC_WORKER_MAX_AGE` (default 4hr).
  - Counts live workers and ready tasks; spawns up to `ARC_WORKER_MAX` (default 4) fresh sessions, each running `bash bin/worker-shell.sh <name>`.
- `bin/worker-shell.sh` is the worker bootstrap. It performs the atomic ledger claim in bash (no agent yet), then `exec`s an **interactive** `claude` with the task id baked into the prompt and `--append-system-prompt`.
- When the claude process exits, the tmux session dies. The next factory tick respawns if more work exists. Each session sees fresh code, fresh skills, and a clean context window.

The interviewer remains a single long-lived pane (`bin/launch.ts`, single-pane session `arc`). Only workers are ephemeral.

## Why not alternatives

- **Keep long-lived workers, clear context between tasks.** No reliable way to "reset" a claude session's context short of restarting it. Once we're restarting, ephemeral is simpler.
- **Headless `claude -p` instead of interactive.** Violates CHOICES.md M-0002: this Max account has extra-usage off; `-p` invocations consume from the wrong billing bucket. Interactive with a positional prompt arg gives us one-shot semantics on the correct billing path.
- **Cron-driven workers instead of a factory daemon.** Cron can spawn but can't reap by age, can't observe live count, can't cap concurrency cleanly. A long-running supervisor is simpler than a cron + lockfile + age-check shell script.
- **Reap on completion instead of by age.** Already implicit — sessions die when claude exits. The 4hr reap catches stuck/hung workers, not normal completions.

## Consequences

**Positive:**
- Every task starts with a clean context window. No bleed-over.
- Code updates take effect on the next spawn — no manual restart cycle.
- Concurrency is a single env var (`ARC_WORKER_MAX`), enforced by the factory.
- The atomic-claim guarantee from a single SQL `UPDATE…RETURNING` still holds; the bootstrap claim in bash is documented exception, not a race.

**Negative / accepted costs:**
- Per-task startup latency: each task pays the `claude` cold-start (~1–3s) instead of amortizing it. Acceptable for AFK work.
- Workers can't share warm caches or in-memory state across tasks. Also acceptable — the ledger is the only shared state.
- A worker that genuinely needs >4hr is killed mid-task. Mitigation: 4hr is generous for any well-decomposed task; if a task can't fit, it should have been decomposed via the bookie.
- The bash claim is a bootstrap exception to the "all writes through bookie" rule. Documented in `worker-shell.sh` and `.claude/agents/bookie.md`.

## How we verify this is working

- E2E tests in `bin/factory.test.ts` exercise empty-ledger no-op, N_MAX cap, reap-by-age, and atomic-claim race with parallel shells.
- Operationally: `tmux list-sessions | grep arc-worker-` should show ≤ N_MAX live sessions, none older than MAX_AGE, and respawn within `INTERVAL` seconds of a task reaching `state=ready`.
