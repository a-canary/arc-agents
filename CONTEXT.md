# arc-agents — CONTEXT

Glossary of domain terms. Definitions only — no implementation details, no spec, no decisions. For decisions see [CHOICES.md](./CHOICES.md). For ADRs see [docs/adr/](./docs/adr/).

---

## Ledger
The SQLite database at `~/vault/ledger.db` that is the system of record for all work. Two tables: `issues` (rows of work) and `issue_events` (append-only audit log). Every meaningful state change goes through it.

## Issue
A row in the ledger representing a unit of work. Has a `kind` (task, event, reply, prd, prefetch), a `source_module` (required for `event`/`reply`; identifies the producing module, e.g. `arc-chat`), a `type` (priority class — interactive, HITL, mvp, security, …, deferred), and a `state` (ready → claimed → wip → review → merged, or → blocked / failed / cancelled).

## Interactive (type)
A `type` reserved for work the user is *actively waiting on*: next interviewer reply (`chat_out`), prefetch/precache for a pending taste/impact decision, UX request. Ranks above HITL in priority. Served by the fast-pass slot pool in the factory (see CHOICES `I-0007`).

## HITL
"Human-In-The-Loop." A `type` reserved for issues that an autonomous AFK worker cannot complete alone — they require a human decision, action, or external account. Distinct from the [HITL Prompt](#hitl-prompt) (a row in `hitl_prompts`, which is a *question to the user* surfaced via the UX Module Contract).

## Task
An issue with `kind=task`. The only kind that workers claim and execute.

## Worker
A short-lived `claude` invocation that claims one task, executes it, and exits. Workers run inside ephemeral tmux sessions named `arc-worker-<rand>`. One worker = one tmux session = one claude process = one task. There is no long-lived worker.

## Factory
The supervisor daemon (`bin/factory.ts`) that reaps stale worker sessions and spawns fresh ones when the ledger has ready tasks. The factory is always-on; workers are not.

## Interviewer
An ephemeral `claude` session spawned by the factory's fast-pass pool to service one `chat_in` row (ADR 0003). Same spawn path as workers — there is no long-lived interviewer. The user posts via `bin/arc-chat.ts post`; the interviewer reads prior turns for the same `thread_id` from the ledger (via `render-prompt` thread replay), replies by creating a `chat_out` row, exits. Owns the two user-facing UX flows: **Intake** (UX_1) and **HITL Prompt** (UX_2). Writes to the ledger via the bookie subagent the same way workers do.

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

## Diff Review
A pre-commit phase in the worker loop: the worker spawns an independent subagent (via the `/diff-review` skill, no shared reasoning trace) that reviews the finalized diff against the task brief + touched ADRs and returns a structured JSON report `{consequences, surprises_vs_brief, gaps_vs_brief, adr_conflicts}`. The worker logs the report as a `kind=diff_review` event. `bin/ledger.ts update --state merged` refuses without a prior `diff_review` event for the issue id; bookie rule #7 mirrors the refusal. Surprises/gaps must be reconciled in the diff or addressed in `evidence_md`. See [I-0008](CHOICES.md#i-0008-pre-commit-diff-review-gate).

## Decomposition
The act of breaking a parent task into N children atomically: insert N child issues + set `parent.blocked_by=[childIds]` + flip `parent.state='blocked'`. Children inherit the parent's `type` and `pool`; for human-decision rows the child is `type=HITL, hitl=1`. Fanout cap = 5; recursion allowed. The new `ledger join-status <parent>` verb is the read-only check for the parent's barrier. See also: [Join](#join), [Land](#land), [Fanout](#fanout).

## Terminal State
An issue state from which there is no exit: `merged` and `cancelled`. Once a row reaches a terminal state, no writes are accepted against it.

## AFK Shutdown
The checklist a worker runs through before exiting its claude session: drive the task to a terminal state (merged + evidence + pr, or failed + evidence), or decompose (state=blocked) and let the SQL trigger resume the parent later. Suggested but not enforced: verify in-scope docs are still accurate; commit as the configured git user; remove the worktree. The Stop hook (`hooks/stop.sh`) reminds the worker of this checklist; it does not enforce stale-doc checks.

## Worktree
A git working copy under `~/worktrees/<repo>-<slug>/` provisioned by the harness (not the worker) for the lifetime of one task. Creation happens in `bin/worker-shell.sh` *before* `claude`/`pi` is exec'd — `git worktree add --force -B worker/<slug> ~/worktrees/<repo>-<slug>/ main` (parent dirs auto-mkdir'd by git ≥ 2.30). The shell then `cd`s into the new dir and execs the engine, so the agent boots with that path as its CWD already on disk. If a worker ever finds its CWD missing (reaped-then-reclaimed race; wrong working tree; exec in a different root), `Bash` will fail with "no such file or directory" because it does not auto-mkdir — but `Write`/`Edit` auto-mkdir the target's parent, so the documented escape is to write any path inside the worktree (e.g. a `.gitkeep`) to bootstrap the dir, then resume bash. Lifecycle:
1. Harness creates it from `main` on a feature branch (worker does not).
2. Worker does work, commits locally.
3. **Before merging to `main` in git**: worker must push the feature branch to origin. Unpushed commits on a reaped worktree are unrecoverable — `git worktree remove` deletes the `.git` and all commits not reachable from a remote branch.
4. Worker merges to `main` in git, updates the ledger row to `state=merged`.
5. The worktree is removed by `worktree-reaper` on the next factory tick — provided none of the preservation gates in [Reap](#reap) trip. A `merged` row only proves the branch landed; scratch edits on top are a salvage call (the reaper preserves `dirty-uncommitted` dirs for human review).

## Reap
The factory's act of killing a worker tmux session that has exceeded the max-age threshold (4hr). Independent of ledger state — a reaped worker's task remains whatever state it last left. The reaper also removes worktrees for `merged`/`failed`/`cancelled` rows (see `worktree-reaper.ts`).

A reaper emit of `outcome: "removed"` means `git worktree remove -f -f` returned OK and the dir is gone — but `outcome` is not always `removed`. The row-driven reaper can emit one of five preservation outcomes and leave the dir on disk: `has-commits` (failed/cancelled with unmerged commits — salvage), `dirty-uncommitted` (uncommitted/untracked edits on top of merged branch — salvage), `main-working-tree` (path misrecorded as a main checkout — columns nulled, leak-detection owns the dir), `git-remove-failed` (git refused), `no-parent-repo` (path not part of any git worktree). The 7-day backstop disk-scan adds `kept-has-commits` (unmerged commits — never auto-removed, salvage), `kept-too-young` (HEAD == main, age under maxAgeSec), `kept-live-row` (a live ledger row owns it), and `not-a-worktree` (dir isn't a git worktree — left untouched). A worker re-entering a path that was "reaped" must NOT assume the dir is gone — verify with `test -d <wt>` and, if present, `git -C <wt> rev-parse HEAD` against `origin/main` and `git reset --hard origin/main` if it lags. Observed footgun (2026-06): reaper event emitted `removed` yet a re-entered worker found the dir still on disk with HEAD 4 PRs behind main.

## UX Module
An external installable that fulfills the [UX Module Contract](docs/adr/0002-ux-module-contract.md). Surfaces HITL prompts to the user in some medium (TUI, webui, Discord, email). Declared in `~/.config/arc/config.yaml`; liveness via ledger heartbeats. The harness owns no transport code — modules pull from the ledger (sync mediums) or ship their own pusher daemon (async mediums).

## HITL Prompt
A row in `hitl_prompts`. The vocabulary by which the interviewer (or a `class=taste` worker) asks the user something. Has a `kind` (ask_text, ask_choice, ask_confirm, notify, show_artifact), a `class` (taste or impact), and the usual state machine. Distinct from a HITL **Issue** in the issues table — issues are units of work; prompts are questions about work.

## HITL Class
Either `taste` or `impact`. Taste prompts have a 60s timeout, a `recommended` answer, and let dependent work continue speculatively. Impact prompts hard-block dependent work until the user replies. Workers may emit taste prompts directly; impact prompts must come from the interviewer (workers decompose instead).

## Authorize row
An HITL [Decomposition](#decomposition) child whose title follows `Authorize <action>` (commit, push, deploy, force-push, …) and whose work IS that action — committing the staged files, pushing the branch, deploying the artifact. Distinct from a merge-gate: the parent's `diff_review` verdict drives the parent's `merge` transition and says nothing about whether the authorize action should happen. See bookie rule #8 and `skills/bookie/SKILL.md` for cancel conditions.

## Delivery
A row in `hitl_deliveries`. One per (prompt, alive module) pair. Tracks render/retract state and the module-specific `external_ref` (e.g. Discord message id) used to scrub the surface when another module wins the reply.

## Pusher
A daemon shipped by an async UX module (Discord, email) that watches the ledger for deliveries addressed to its module and forwards them to the remote API. The module's heartbeat liveness is the pusher's heartbeat. The harness never opens a socket to a remote service itself.

## Retract
The act of undoing a prompt's render in one medium because the user already answered in another. Modules with `can_retract: true` edit/delete their external message; others (email) mark `state=retracted` without action. Triggered by the SQL cascade when `hitl_prompts.state` transitions to `answered` or `user_diverged`.

## Anchor
The `(repo, branch, HEAD sha)` captured at insert time on a `class=taste` prompt. Marks the divergence point: any commit on `anchor_branch` from `anchor_commit..HEAD` descends from the speculative answer. Used to drive `forward_fix` or `replay` reconciliation when the user picks a non-recommended option. Relies on `G-0005` (one slice per worktree per commit).

## Evidence-First
The epistemological stance that every input — from the user, from research, from another agent, from a prior ledger event — is a *thesis* until verified by observation. Workers and the interviewer never encode an unverified claim into a row body, CHOICES entry, or PR description without naming it as a hypothesis. The doctrine is documented in [roles/AGENTS.md](./roles/AGENTS.md).

## Concern
A worker's escalation of a decision outside its scope, a risky action, or a blocker. In arc-agents the concern *mechanism* is [Decomposition](#decomposition): the worker writes N child rows + flips parent to `blocked`, rather than a separate `outbox/concern-*.md` file (as in the predecessor `~/agents/` system). The term is preserved for vocabulary continuity. The merge of "merge a PR" and "join child dependencies" was overloaded; this glossary now distinguishes [Land](#land) and [Join](#join).

## Fanout
A parent task creates N child tasks in one atomic write (`ledger decompose <parent> --child ...`). The children run in parallel; the parent re-claims once every blocker reaches a terminal state. The fanout cap is 5 children per call; for more, decompose recursively. Children inherit the parent's `type` and `pool` (with per-child override available via JSON `--child`).

## Land
The Git hard-merge lane. A child worker ships a PR; `.claude/agents/merger.md` runs the gate stack and `gh pr merge --squash --delete-branch` is the canonical land step. Workers do not `gh pr merge` directly. Land is the only path that advances a child to `state=merged` via GitHub's state machine. Distinct from [Join](#join), which is the ledger-side barrier release.

## Join
The release of the parent's dependency barrier. A parent is unblocked when every blocker reaches a terminal state: `kind=task` parents require every blocker to be `merged`; `kind=sprint` parents requeue when every blocker is `merged|failed|cancelled`. The work is done by the SQL triggers `unblock_dependents` and `unblock_sprint_parents` (see `src/ledger/migrate.ts:1043-1080`); `ledger tick` is the polling backstop. `ledger join-status <parent>` is the read-only check. Exit 0 means unblocked; 1 means still pending; 2 means missing id. Distinct from [Land](#land), which is the Git merge that changes a child to `state=merged`.

## AXI
Agent Execution Interface — the `ledger` CLI as a delegation surface arc-skills' `/director` binds to (`task-delegation: arc-agents`) without depending on this repo being operational. Workers and any UI read and write work only through `ledger <verb>`; non-TTY output is JSON by default (`--csv`/`--md` opt-in render). Full principles and the TOON deviation are documented in [a-canary/arc-skills](https://github.com/a-canary/arc-skills)'s `docs/AXI.md`, adapted from the published [axi.md](https://axi.md) framework. **Flagged for re-analysis** — the full verb surface (what's stable-contract vs internal) needs its own PRD pass; treat as provisional until then.

## Steering Mode
The `mode` of a feedback row: `imperative` (an order — fires a direct verb now) or `hypothesis` (a guess — validated on one concrete case before any scale). NULL is unstamped and treated as a hypothesis. Classified from the input by the pure `parse()` (a leading `!` ⇒ imperative).

## author_trust
The trust class of a feedback row's author: `operator` (trusted — a single row acts) or `product` (untrusted — three distinct submitters needed to corroborate). Keyed on the *author*, not the channel; closes the `source='direct'` degeneracy where any single product row could mint a PRD.

## director-brief
The AXI verb `ledger director-brief --project <P>`: a plain status utility partitioning git-log, project ledger rows, and open feedback into `done` / `current` / `next` buckets with size hints. Pure module `brief()` in `src/director/director-brief.ts` behind a thin CLI shell. Consumed by [a-canary/arc-skills](https://github.com/a-canary/arc-skills)'s `/director` — the actual instantiated, event-driven mission-owning agent (12hr cron backstop). arc-agents exposes the data; it does not run the loop.

## mission-gap
A plain utility (`src/director/mission-gap.ts`, pure `gaps()`) that diffs a set of goals against ledger state and proposes capped, uncovered-goal gaps. Called by an external driver (`/director`'s gap-analysis step); arc-agents does not run this autonomously itself.

## Governor
A standalone token/activity guard (`bin/director-governor.ts`) bound into a caller's loop via the caller's own `AGENTS.md` — knows nothing about "Director" or any owning agent. Gates on `KILL`/`PAUSE` sentinel files (path supplied by the caller, e.g. `<parent-repo>/.arc/director/`) and a **per-repo** weekly token budget (`repoBudget`, also caller-supplied — different repos can declare different budgets).

### Sentinel-file flags
Sentinel-file flags are the simplest reactive control: `existsSync` of a named file under a caller-supplied directory (`sentinelDir`). No history — they cannot record who set the flag, when, or why. If stateful control (who/when/why provenance) is needed, upgrade to a ledger row instead. Precedence, most severe first:
1. **KILL** — caller must not run at all (`allowCaller: false`).
2. **PAUSE** — caller may run but must not spawn ordinary new work (`allowSpawn: false`), except critical-only work (see budget rule below).
3. **Over budget** — ordinary spawns blocked, but `restrictTo: "critical-only"` lets production-stability/security work continue.
4. **OK** — run and spawn freely.

### Budget behavior
Over-budget no longer hard-stops: `restrictTo: "critical-only"` lets production-stability/security work continue while ordinary spawns pause. **Known gap:** the spend figure compared against `repoBudget` is still a host-wide codeburn sum — there is no per-repo token *attribution* yet, only a per-repo *threshold*. Never fails fatally — the shell always exits 0.

## Parent repo (mission-driver construct)
The repo where `/director`'s own state lives (`.arc/director/`) and whose `AGENTS.md` declares which other repos it manages and how (bindings: `task-delegation`, `workspace`, `budget`, etc. — see arc-skills' `/director` SKILL.md). Replaces the earlier vault-rooted "Director Group" (`~/vault/agents/directors/<group>/`) — that path and `directorGroupFromCwd()` were removed; see [ADR-0012](docs/adr/0012-director-agent-axi.md).

## Pattern
A symptom observed across multiple rows, workers, or cycles. Distinguished from a one-off observation: a single `state=failed` row is an observation; the same failure shape across N rows is a pattern. Patterns escalate to director-level review via [triage-failed](skills/triage-failed/SKILL.md), not per-row patching. Root-cause fixes only — patching symptoms while the root cause persists wastes every future cycle.

## Sibling Slice
Two or more task rows that descend from the same parent PRD and execute in parallel against overlapping surfaces, minting code independently with no shared branch or diff. The [dev promotion gate](#diff-review) reviews each slice in isolation, so cross-slice collisions — divergent helpers covering the same query axis, divergent names for the same concept — land silently until a third slice surfaces the pattern. Observed instance: arc-webui PR #40 added `recentApprovedPrds(db, limit=8)` and PR #41 added `recentlyApprovedPrds(db, limit=5)` — same SQL axis (`kind='prd' AND state='merged' ORDER BY updated_at DESC`), different return shapes, both merged. Reversible: drop one, fold into a shared helper, or document the divergence as intentional. See [Pattern](#pattern) for the cross-row promotion path when a third slice appears.

## Drift
Active renames or convention-residues where the old name still appears somewhere in code, comments, columns, or docs. Each entry has a 7-day TTL from the originating decision. After TTL expires, either the residue is gone (delete the line) or the rename is stuck — file a task to track the blocker and keep the entry until cleared. One line per drift, format:

`- **old-name → new-name** (decided: ADR-NNNN or CHOICES tier) — residue: <where old name still appears>. *expires: YYYY-MM-DD (7d from decision)*`

Current drift:

- **encounter_reply → event** (decided: ADR-0005) — residue: `encounter_mode`/`encounter_timeout_at`/`encounter_default_resolution` columns on `issues` (see `src/ledger/migrate.ts`); `wait-for-ledger --interviewer` doc string; skills/to-ledger, skills/spawn, skills/bookie kind lists. *expires: 2026-05-26 (7d from ADR-0005)*
- **chat_in / chat_out → event / reply with source_module** (decided: ADR-0005) — residue: `bin/arc-chat.ts` usage and code comments; `bin/ledger.ts:444` thread-replay comment; `bin/wait-for-ledger.ts` `--interviewer` filter mentions `chat_in`. *expires: 2026-05-26 (7d from ADR-0005)*
