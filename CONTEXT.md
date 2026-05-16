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
The single long-lived `claude` session attached by `bin/launch.ts`. User-facing chat. Not a worker — does not claim tasks. Writes to the ledger via the bookie subagent the same way workers do. Owns the two user-facing UX flows: **Intake** (UX_1) and **HITL Prompt** (UX_2).

## Intake (UX_1)
The interviewer's new-thread workflow. User posts a brief description or link — could be a new project, new feature, pivot on an existing feature, a bug, a one-off question, or an artifact-generation request. The interviewer's job:
1. **Align** scope, intent, and success criteria via the `grill-with-docs` skill, anchored on `CONTEXT.md` + relevant ADRs.
2. **Cascade** design choices via the `choose-wisely` skill, which iterates `CHOICES.md` to surface and resolve up/downstream design and architectural implications.
3. **Decompose** the aligned, choice-resolved intent into ledger rows (tasks for workers, HITL prompts for the user) via the bookie.

CHOICES vs ADRs (not redundant): `CHOICES.md` is the working ledger of scoped decisions (M/A/G/S/D/I tiers), one line each, cheap to add and revise — `choose-wisely` operates here. ADRs are the long-form record of hard-to-reverse architectural trade-offs (context, alternatives, consequences). A CHOICES entry graduates to an ADR when the trade-off is heavy enough to warrant the narrative. `grill-with-docs` reads ADRs (and `CONTEXT.md`) as anchor documents so questions are grounded in existing decisions.

## HITL Prompt Flow (UX_2)
The user-facing surface for an in-flight task that needs a high-impact decision or a human-taste judgement between multiple options. The interviewer (or a `class=taste` worker) writes a row to `hitl_prompts`; the UX Module Contract fans it out to every alive `arc-ux` module; the first reply wins; losing deliveries retract. See [HITL Prompt](#hitl-prompt), [HITL Class](#hitl-class), [Delivery](#delivery), [Retract](#retract).

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

## UX Module
An external installable that fulfills the [UX Module Contract](docs/adr/0002-ux-module-contract.md). Surfaces HITL prompts to the user in some medium (TUI, webui, Discord, email). Declared in `~/.config/arc/config.yaml`; liveness via ledger heartbeats. The harness owns no transport code — modules pull from the ledger (sync mediums) or ship their own pusher daemon (async mediums).

## HITL Prompt
A row in `hitl_prompts`. The vocabulary by which the interviewer (or a `class=taste` worker) asks the user something. Has a `kind` (ask_text, ask_choice, ask_confirm, notify, show_artifact), a `class` (taste or impact), and the usual state machine. Distinct from a HITL **Issue** in the issues table — issues are units of work; prompts are questions about work.

## HITL Class
Either `taste` or `impact`. Taste prompts have a 60s timeout, a `recommended` answer, and let dependent work continue speculatively. Impact prompts hard-block dependent work until the user replies. Workers may emit taste prompts directly; impact prompts must come from the interviewer (workers decompose instead).

## Delivery
A row in `hitl_deliveries`. One per (prompt, alive module) pair. Tracks render/retract state and the module-specific `external_ref` (e.g. Discord message id) used to scrub the surface when another module wins the reply.

## Pusher
A daemon shipped by an async UX module (Discord, email) that watches the ledger for deliveries addressed to its module and forwards them to the remote API. The module's heartbeat liveness is the pusher's heartbeat. The harness never opens a socket to a remote service itself.

## Retract
The act of undoing a prompt's render in one medium because the user already answered in another. Modules with `can_retract: true` edit/delete their external message; others (email) mark `state=retracted` without action. Triggered by the SQL cascade when `hitl_prompts.state` transitions to `answered` or `user_diverged`.

## Anchor
The `(repo, branch, HEAD sha)` captured at insert time on a `class=taste` prompt. Marks the divergence point: any commit on `anchor_branch` from `anchor_commit..HEAD` descends from the speculative answer. Used to drive `forward_fix` or `replay` reconciliation when the user picks a non-recommended option. Relies on `G-0005` (one slice per worktree per commit).
