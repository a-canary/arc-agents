# arc-agents — CONTEXT

Glossary of domain terms. Definitions only — no implementation details, no spec, no decisions. For decisions see [CHOICES.md](./CHOICES.md). For ADRs see [docs/adr/](./docs/adr/).

---

## Ledger
The SQLite database at `~/vault/ledger.db` that is the system of record for all work. Two tables: `issues` (rows of work) and `issue_events` (append-only audit log). Every meaningful state change goes through it.

## Issue
A row in the ledger representing a unit of work. Has a `kind` (task, chat_in, encounter_reply, prd), a `type` (priority class — HITL, mvp, security, …, deferred), and a `state` (ready → claimed → wip → review → merged, or → blocked / failed / cancelled).

## Task
An issue with `kind=task`. The only kind that workers claim and execute.

## HITL
"Human-In-The-Loop." A `type` reserved for issues that an autonomous AFK worker cannot complete alone — they require a human decision, action, or external account. HITL is the highest priority class.

## Worker
A short-lived `claude` invocation that claims one task, executes it, and exits. Workers run inside ephemeral tmux sessions named `arc-worker-<rand>`. One worker = one tmux session = one claude process = one task. There is no long-lived worker.

## Factory
The supervisor daemon (`bin/factory.ts`) that reaps stale worker sessions and spawns fresh ones when the ledger has ready tasks. The factory is always-on; workers are not.

## Interviewer
The single long-lived `claude` session attached by `bin/launch.ts`. User-facing chat. Not a worker — does not claim tasks. Writes to the ledger via the bookie subagent the same way workers do.

## Claim
The atomic transition `state=ready → state=claimed` performed by a single SQL `UPDATE…RETURNING`. Race-safe by construction — exactly one worker wins per task. Performed in bash by `worker-shell.sh` before the agent boots; the **only** ledger write that does not go through the bookie subagent.

## Bookie
A claude subagent (`.claude/agents/bookie.md`) that is the sole authority for ledger **writes** (create, update, decompose, event) inside an agent session. Workers and the interviewer delegate every write to the bookie via the Agent tool. The bookie validates against project rules and refuses non-compliant writes. Reads (show, list) bypass the bookie and run directly.

## Decomposition
The act of breaking a parent task into N HITL children atomically: insert N child issues + set `parent.blocked_by=[childIds]` + flip `parent.state='blocked'`. Used when an AFK worker discovers a blocker only a human can resolve. Fanout capped at 5 per call; recursion allowed.

## Terminal State
An issue state from which there is no exit: `merged` and `cancelled`. Once a row reaches a terminal state, no writes are accepted against it.

## AFK Shutdown
The checklist a worker runs through before exiting its claude session: drive the task to a terminal state (merged + evidence + pr, or failed + evidence), or decompose it into HITL children (state=blocked). Suggested but not enforced: verify in-scope docs are still accurate; commit as `a-canary`; remove the worktree. The Stop hook (`hooks/stop.sh`) reminds the worker of this checklist; it does not enforce stale-doc checks.

## Worktree
A git working copy under `~/worktrees/<repo>-<slug>/` created by a worker for the lifetime of one task. Removed by the worker as part of AFK shutdown.

## Reap
The factory's act of killing a worker tmux session that has exceeded the max-age threshold (4hr). Independent of ledger state — a reaped worker's task remains whatever state it last left.
