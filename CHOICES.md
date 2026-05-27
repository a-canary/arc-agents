# arc-agents — CHOICES

Project-scope decisions. System-level decisions live in `~/arc-agents/system/CHOICES.md` (post-migration). Higher constrains lower.

---

## Mission

### M-0001: Ledger-Dispatched Agent Harness
SQLite ledger at `~/vault/ledger.db` is the message bus. No daemons, no IPC. State transitions are atomic SQL.

### M-0002: Interactive Panes Only
Runtime is always-on `claude` panes. No headless `claude -p` subprocesses. Primary reason: transparency and observability — every worker is an attachable tmux pane with live tool-use rendering and full scrollback. Side benefit: interactive panes bill against the Max Claude-Code bucket rather than extra-usage.

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

### A-0006: Factory Optional for Solo-GPU Projects *(candidate — 2026-05-21)*
Factory (`bin/factory.ts`) is mandatory for multi-worker fanout but optional for projects with `max_concurrency=1` and a single physical resource (e.g. starlight-slm: one Quadro P600). For such projects, the human (or a single cron entry) spawns workers directly; the factory can be `systemctl stop` without losing functionality. Alternative if factory is desired: replace tmux-spawn with `systemd-run --user --scope` (more reliable under systemd-user env than the current `tmux new-session -d` path, which fails silently when the user manager lacks a TTY). *Surfaced when arc-factory.service entered a spawn-loop and was stopped — replacing it was unnecessary for starlight-slm's max_concurrency=1.*

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

Per-commit: diff ≤ `SLICE_GUARD_MAX_LINES` (default 2000 modified-line equivalents) AND touches ≤ `SLICE_GUARD_MAX_AREAS` (default 1) top-level path segments.

**Paired-area exception**: a single thin-vertical may legitimately touch two areas when the slice is an endpoint + its companion static asset (e.g. `bin/` + `assets/` for a HITL panel served by `bin/webui-server.ts`). Use `SLICE_GUARD_SKIP=1` to bypass — this is the documented mechanism, not a workaround. The pairing is always endpoint + static served artifact; it does not cover two independent concerns.

### G-0006: Two-Tier Model Policy
Opus 4.7 for synthesis ($10/day cap). minimax-m2.7 for impl (unlimited, direct API).

### G-0007: No Symlinks During Migrations
Move files; subagents fix refs.

### G-0008: TypeScript Default
TS over Python where reasonable. Bun runtime.

### G-0009: In-Pane Interviewer When No UX Module Alive *(candidate — 2026-05-21)*
When `arc-ux heartbeat` shows zero alive UX modules (no module heartbeat within liveness threshold), the active claude pane *is* the UX surface. The interviewer writes UX_2 prompts directly to stdout (Director report blocks) and marks deliveries as `delivered_in_pane` rather than queueing them into the broadcast-to-no-one void. Workers still emit `hitl_prompts` rows; the interviewer relays them to the active pane on its next turn. *Surfaced because arc-tui heartbeat was ~24h stale during starlight-slm intake — HITL emit would have queued with zero deliveries; opted for in-pane direct communication instead.*

### G-0010: Pool-Aware Factory Dispatch
Factory dispatches on the `pool` column (not `type`). Slot model: 4-any (any pool) + 2-interactive (`pool=interactive` fast-pass). `claimOnce(db, worker, poolFilter?)` in `src/ledger/claim.ts` builds one SQL UPDATE…RETURNING; pool clause is injected only when filter is set. `bin/worker-shell.sh` reads `ARC_CLAIM_POOL` (preferred) or `ARC_CLAIM_TYPE` (deprecated alias) to set the filter.

---

## Skills

### S-0001: Mandatory Skills
`ke-recall` (start) · `ke-learn` (stop, queued) · `spawn` (ledger write, not process spawn).

### S-0002: Skills Location
`~/repos/arc-agents/skills/`.

### S-0003: Replay-Shadow as the Confidence Primitive
Capture one real worker turn → replay against candidate config in an isolated sandbox → diff transcript + ledger writes + quality signals. Run on a corpus (~30) before promoting prompt/template/model/skill-set changes. Generic dev practice, not arc-specific; harness is per-system (`bin/arc-replay.ts` for arc-agents). Skill defines contract, system wires it. Not a substitute for live shadow on concurrency/UX/scale regressions. See `skills/replay-shadow/SKILL.md`.

### S-0003.c: Canonical Transcript Source for Worker Turns
Replay-shadow fixtures use the claude session JSONL at `~/.claude/projects/<proj>/<session>.jsonl` as the canonical transcript for a worker turn. Rationale: it is the only artifact that contains the full ordered sequence of model I/O, tool calls, and tool results in a single file written by the runtime itself — no reconstruction needed. Ledger `issue_events` rows are the canonical *output-diff* (a separate fixture part), not the transcript; they record decisions but not deliberation. Tmux scrollback is lossy (truncation, ANSI noise) and not a stable format. The session JSONL is keyed by session id; the binding from worker → session is recoverable from the worker tmux name + `~/.claude/projects/<proj>/` directory mtime (capture procedure stores the resolved path in `fixture.json`).

### S-0004: Intake Skill — grill-with-docs
Path: `~/projects/mattpocock-skills/skills/engineering/grill-with-docs/SKILL.md`. Purpose: stress-test a plan against `CONTEXT.md` + `docs/adr/` anchor docs, sharpen terminology, update docs inline as decisions crystallise. Who may invoke: **interviewer always** (step 1 of Intake/UX_1 per U-0007). **Workers**: invoke only when a task body explicitly requests it (e.g., scope-alignment tasks). Default for routine impl/quality tasks is to skip — workers act on already-decomposed rows.

### S-0005: Intake Skill — choose-wisely
Path: `~/agents/skills/governance/choose-wisely/SKILL.md`. Purpose: iterate `CHOICES.md` to surface and resolve up/downstream design choices, cascade impact across M/A/G/S/D/I tiers, plan implementation phases. Who may invoke: **interviewer always** (step 2 of Intake/UX_1 per U-0007). **Workers**: invoke when a task introduces or revises a CHOICES entry; otherwise skip. Cascades will reference S-0004/S-0005 once these pointers exist.

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
`bin/arc-chat.ts` — user-facing chat surface (`post`/`tail`/`threads`). `bin/factory.ts` — supervisor daemon spawning ephemeral worker AND interviewer sessions (M-0004 + ADR 0003); fast-pass pool serves `pool=interactive`. `bin/worker-shell.sh` — bootstrap: atomic claim → `ledger render-prompt` (with thread replay) → exec interactive `claude`.

### I-0003: Bookie Subagent
Writes ledger rows on behalf of agents. Single point of validation.

### I-0004: Profiles
`profiles/<role>.json` — context_summary, boot_skills, model, daily_budget_usd, max_concurrency, worktree.

### I-0005: Install via bun link
`bun link` from `~/repos/arc-agents/` → `~/.local/bin/{ledger,agent}`. Only after merge to main.

### I-0006: Git Author
Commits use the deployer's configured git user (`git config user.name` / `user.email`). No hardcoded author in framework code — repo is public, deployed by many.

### I-0007: arc-webui Tailscale-Only Binding
`bin/webui-server.ts` binds the tailscale0 interface address resolved via `resolveIfaceAddr()` (override with `ARC_WEBUI_IFACE`). Fails fast on `Bun.serve` boot if the interface is absent — no `0.0.0.0` fallback. Verified S10: socket listens only on `100.91.151.13:PORT`; connections from eno1 LAN IP and loopback are refused (`ECONNREFUSED`). Blocks public-network exposure of the HITL/AFK SSE feeds.

### I-0008: Pre-Commit Diff-Review Gate
Before `git commit`, the worker spawns an independent subagent (no shared reasoning trace) via the `/diff-review` skill that reviews the finalized diff against the task brief + touched ADRs and returns JSON `{consequences, surprises_vs_brief, gaps_vs_brief, adr_conflicts}`. Worker asks bookie to log it as a `kind=diff_review` event. `bin/ledger.ts update --state merged` refuses if no `diff_review` event exists for the issue; bookie mirrors the rule (rule #7). Surprises/gaps must be reconciled in the diff OR addressed in `evidence_md` at merge.

### I-0009: GPU-Claim Mutex in Bookie *(candidate — 2026-05-21)*
For tasks tagged `gpu-bound` (or with `project` in a configured gpu-projects list), the bookie refuses a `claim` write while any other row matching the same tag/project is in state `wip` or `claimed`. Removes the only reason factory `N>1` is dangerous for single-GPU work like starlight-slm (Quadro P600 4GB). Cheap: one extra `EXISTS` clause in the bookie claim validator. *Surfaced while driving starlight-slm gen4 dispatch — concurrent training would OOM-livelock the box.*

### I-0010: Embed Dispatch Ergonomics in Training Rows *(candidate — 2026-05-21)*
Rows that gate human-action runs (training dispatch, long-running pipelines, hardware-bound jobs) carry structured fields in `body_md`: `command:`, `expected_wall:`, `gpu_footprint:`, `next_action_owner: human|agent`. Lets a human reading the row decide to dispatch without re-reading NEXT.md or skill docs, and lets the bookie refuse `claim` from an agent worker when `next_action_owner=human`. *Surfaced from the gen4 dispatch row originally framed as needing human action — the row body should make that explicit so agents don't speculatively claim it.*

### I-0011: triageUnset Auto-Classification
`triageUnset(db, budget=10)` in `bin/factory.ts` runs each factory tick. Selects up to `budget` ready rows with `agent='agent_unset' OR pool='pool_unset'` ordered by SORT_KEY_SQL. Rules: agent — `source_module='arc-chat'` → `chat`; `kind='prd'` → `director`; else → `developer`. Pool — `tier IN (prod,trust,mvp)` → `build`; else → `explore`. Tier is never touched. Each triaged row gets a `kind='triaged'` event (migration 018). Escape hatch: `ARC_TRIAGE_DISABLE=1`. Budget override: `ARC_TRIAGE_BUDGET=N`.

---

## UX

Pointers; the why lives in [ADR 0002 — UX Module Contract](docs/adr/0002-ux-module-contract.md).

### U-0001: Pluggable UX, Harness Owns No Transport
The harness defines a contract; modules (TUI, webui, Discord, email) fulfill it. Sync mediums pull from the ledger; async mediums ship their own pusher daemon. Bookie refuses HITL writes when no alive module implements the verb, atomically spawning a bootstrap install task instead.

### U-0002: Two HITL Classes
`taste` (60s timeout, recommendation written at create, dependent work proceeds speculatively) vs `impact` (no timeout, dependent work blocks). Workers may emit taste directly; impact must come from interviewer (workers decompose).

### U-0003: Speculative Execution + Anchor
Taste prompts capture `(repo, branch, HEAD sha)` at create. Divergent user replies reconcile via `forward_fix` (default — spawn follow-up task) or `replay` (reset and re-run from anchor). No per-commit tagging; `G-0005` guarantees the anchor is sufficient. Taste prompts serialize per worktree.

### U-0004: Two-Table HITL Schema
`hitl_prompts` + `hitl_deliveries` (one delivery row per alive module per prompt). Broadcast on create, first-reply-wins via atomic UPDATE on `hitl_prompts.state`, SQL cascade flips loser deliveries to `retracted`. Same primitives as `issues` + `issue_events`.

### U-0005: Config Declares, Ledger Tracks
`~/.config/arc/config.yaml` is the declarative contract (verbs implemented, artifact render capabilities, can_retract, cli, pusher). Ledger holds liveness via heartbeats. No transport, auth, or endpoint fields in config — those are the module's internal business. Schema: [system/config-schema.json](system/config-schema.json); canonical example: [system/config.example.yaml](system/config.example.yaml).

### U-0006: Canonical Artifact Types
Interviewer produces medium-agnostic artifacts (`text/markdown`, `text/diff`, `chart/vega-lite`, `diagram/mermaid`, `image/png`, `table/rows`). Modules declare per-type render strategy (`native`, `rasterize-png`, `ascii-degrade`, …, `unsupported`). Conversion is the module's job; agents never produce per-medium variants.

### U-0007: Interviewer Owns Intake (UX_1) and HITL Prompts (UX_2)
The two user-facing flows are both interviewer-mediated. **Intake (UX_1)**: on a new chat thread (idea, feature, pivot, bug, one-off, artifact request) the interviewer runs `grill-with-docs` to align scope/intent against `CONTEXT.md` + ADRs, then `choose-wisely` to cascade through `CHOICES.md` and resolve up/downstream design choices, then decomposes into ledger rows via bookie. **HITL Prompt (UX_2)**: in-flight tasks needing impact decisions or taste judgements emit `hitl_prompts` rows; the UX Module Contract handles fanout/first-reply-wins/retract. See [CONTEXT.md → Intake](CONTEXT.md#intake-ux_1) and [HITL Prompt Flow](CONTEXT.md#hitl-prompt-flow-ux_2).

### U-0008: CHOICES vs ADRs
`CHOICES.md` is the working ledger of scoped decisions (one line each, M/A/G/S/D/I tiered, cheap to add/revise) — `choose-wisely` operates here. `docs/adr/` is the long-form record of hard-to-reverse architectural trade-offs (context, alternatives, consequences). A CHOICES entry graduates to an ADR when the trade-off warrants the narrative. Not redundant: CHOICES is the cascade surface, ADRs are anchor reading.
