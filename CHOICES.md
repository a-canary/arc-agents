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

### A-0002: Five Profiles
Five dispatch profiles (`profiles/*.json`, loaded by `loadAll()`):
- **Director** — portfolio interviewer; UX_1 new-thread intake (grill-with-docs) + UX_2 HITL. User-facing.
- **Developer** — implements ledger-dispatched tasks in per-task worktrees; claims oldest ready, ships one PR per slice, delegates the land step to the merger agent.
- **Admin** — system health: cron, vault backup, ledger compact/vacuum, budget rotation, KE reindex. Never claims dev tasks.
- **Sprint** — re-entrant thin-vertical supervisor; drives ONE slice to evidence-backed done across re-entries; on re-entry uses `ledger join-status <self>` to confirm the dependency barrier has released.
- **Triage** — drains `*_unset` ledger rows; batch-assigns {tier,pool,agent} via bookie.

Session-role selection no longer infers from cwd (A-0003, superseded); an agent
is invoked directly against a repo root and reads that repo's `AGENTS.md`.

### A-0003: Agent Selection by CWD — superseded
Retired. Was: `~/vault/agents/admin/` → Admin, `~/vault/agents/director/` →
Director, `~/worktrees/<repo>-*/` / `~/repos/<name>/` → Developer, fallback →
Director. `src/profiles/select-by-cwd.ts` had zero in-repo callers at removal
time (only its own test). Replaced: an agent runs from a repo's own path and
loads that repo's `AGENTS.md` for bindings/roles/constraints — no vault-path
sniffing. See [ADR-0012](docs/adr/0012-director-agent-axi.md) addendum.

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

### G-0010: Pool-Aware Factory Dispatch
Factory dispatches on the `pool` column (not `type`). Slot model: 4-any (any pool) + 2-interactive (`pool=interactive` fast-pass). `claimOnce(db, worker, poolFilter?)` in `src/ledger/claim.ts` builds one SQL UPDATE…RETURNING; pool clause is injected only when filter is set. `bin/worker-shell.sh` reads `ARC_CLAIM_POOL` (preferred) or `ARC_CLAIM_TYPE` (deprecated alias) to set the filter.

---

## Skills

### S-0001: Mandatory Skills
`ke-recall` (start) · `ke-learn` (stop, queued) · `spawn` (ledger write, not process spawn).

### S-0002: Skills Location
`~/repos/arc-agents/skills/`.

### S-0006: commit-review Task Routing
`source_module=commit-review` (ADR 0011) emits rows that may target any repo in the portfolio (e.g. `project=Conjecture`, `project=arc-agents`). Because `worker-shell.sh` isolates every worker into the **arc-agents** worktree (by deriving the worktree root from `~/repos/arc-agents`), a `commit-review`-sourced task with `project≠arc-agents` will silently run in the wrong repo.

**Decision:** `commit-review` tasks MUST verify the target repo **before** becoming `state=ready`. Two valid patterns:
1. The `commit-review` module self-validates: emit rows only after confirming the target repo's worktree exists or can be created (preferred — ADR 0011 governs this).
2. A hygiene pre-flight row: on `hygiene-emit`, the skill checks `source_module=commit-review` and the row's `project` field. If `project ≠ ARC_AGENTS_REPO`, the hygiene row is marked `hitl=1` with a `kind=HITL` class or emits a HITL prompt asking the user to confirm the correct worktree, THEN creates the task with the correct `worktree_path`.

**Current gap (2026-05-27):** Pattern 2 is not implemented. `hygiene-emit` for `source_module=commit-review` observations produces rows in `pool=explore, agent=developer` without verifying the `project` column. Workers subsequently claim these into `arc-agents` worktrees and find nothing to do — forcing a decomposition into a HITL child for director review. The fix requires a CHOICES update to lock the decision and a separate task to implement pattern 2 in `hygiene-dedup.ts` or `bookie-validator.ts`.

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
`~/vault/ke/` — sqlite-vec semantic index over local all-MiniLM-L6-v2 embeddings (`~/vault/ke/_index/vec`). No FTS5, no external service. Deprecated `~/kb/`.

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

### I-0008: Pre-Commit Diff-Review Gate
Before `git commit`, the worker spawns an independent subagent (no shared reasoning trace) via the `/diff-review` skill that reviews the finalized diff against the task brief + touched ADRs and returns JSON containing:

- The audit content (always emitted, ignored by the gate for shape): `{consequences, surprises_vs_brief, gaps_vs_brief, adr_conflicts, axi_violations}`
- The contract fields (required by the merge gate): `{reviewer_identity, reviewed_sha, verdict}` where `reviewer_identity` is distinct from the row's `claimed_by` (no worker self-review), `reviewed_sha` is 7–40 hex chars, `verdict ∈ {pass, fail, comment}`.

Worker asks bookie to log it as a `kind=diff_review` event. `bin/ledger.ts update --state merged` fetches the LATEST `diff_review` event for the issue, parses its payload, and refuses unless (a) all three contract fields are present and well-typed, (b) the verifier is independent of the row's worker, and (c) the diff_review event exists. Bookie mirrors the rule (.claude/agents/bookie.md rule #7). Surprises/gaps must be reconciled in the diff OR addressed in `evidence_md` at merge. Replaces the legacy "any diff_review event exists" check that let workers self-approve (analysis-1780502957 Pattern 1).

### I-0009: Analysis-Writer Contract for Decomposition
When an `analysis-*.md` (or PRD) prescribes a decomposition of a parent task into N child rows, the writer MUST include the exact `bin/ledger.ts decompose <parent-id> --child "..."` invocation in the prescribed-action section — not just describe the intent ("spawn N children") in prose. The atomic verb (`decompose` in `bin/ledger.ts`) inserts N rows + sets `parent.blocked_by` + flips `parent.state='blocked'` in one transaction; any other sequence (`create --parent` per child + `update --blocked-by` + `update --state blocked`, or per-row `create` calls) is a non-atomic partial decomposition that leaves the parent in a stuck-forever state if any step crashes mid-flight. The spawn skill procedure documents this; this decision makes the writer's contract explicit so analysis files cannot be drafted with the broken pattern. Observed: `analysis-1780676509.md` (2026-06-05) prescribed `decompose` correctly; the executing worker (arc-worker-a-xs4pco) used per-row `create --parent` instead, leaving `dream-repo-branches-stranded-on-origin-m` (parent) in `state=blocked, blocked_by=null`. The bookie's `decompose` verb is the only canonical path for creating N children + blocking a parent; raw `create --parent` is reserved for the rare case of attaching a single pre-existing child to an already-blocked parent (see spawn skill "manual pattern" subsection for that escape hatch). Separately, `repoint-blocked-by <id> <blockerId...>` (added for `improve-architecture-ledger-no-cli-verb-`) covers a distinct lifecycle stage: an *already-blocked* row whose stated blocker resolves but whose real prerequisite turns out to be a sibling from the same decomposition. It requires state=blocked and rejects blocker ids already in a terminal state (merged/cancelled), so it cannot be used to fabricate a fresh block or to immediately cascade-unblock via a stale/resolved id — it only repoints among still-live blockers.

Children inherit the parent's `type` and `pool` (with per-child override available via JSON `--child`). A `type=HITL` parent is the only case where children stay HITL priority. For the read-only barrier check, use `ledger join-status <parent>` — returns JSON `{id, state, unblocked, success, pending, failed[, missing]}`; exit 0 unblocked, 1 pending, 2 on missing id. **Success is strict**: all blockers must be `merged` AND none missing AND none failed/cancelled (see CONTEXT.md `Join` entry and `bin/ledger.ts:831` ponytail). A parent blocked by 3 children where 2 merged and 1 failed is *unblocked* (barrier cleared) but NOT *success* — the parent's integration step must handle partial success.

### I-0010: No Correction Path for Stale `blocked_by` (open gap)
`bin/ledger.ts update` hard-refuses `--blocked-by` (see I-0009's atomicity rule) — correct, since it stops silent no-op fan-out. `repoint-blocked-by` (landed since) covers repointing among still-live blockers, but rejects blockers already in a terminal state — so there is still **no CLI verb** to fix a stale `blocked_by` pointer on a row that wasn't created via `decompose` (e.g. a row blocked on a PRD that later merged, while the PRD's real gating child is still open). A worker hit this on `daily-collector-options-flow-quote-snaps` and had to bypass the CLI entirely, writing directly via `src/ledger/db.ts openWithMigrate` — an unaudited write outside the ledger's event-log guarantees. Proposed fix (not yet implemented): `update --blocked-by <ids> --allow-correction` — an explicit escape hatch, distinct from the bare `--blocked-by` the guard rejects, that requires `--evidence` (same shape as `--in-place`/`--no-diff`) naming why the existing pointer is stale. Until implemented, treat any direct `db.ts` write as a HITL-worthy event: log it in the row's event stream so the pattern (I-0009-adjacent) stays visible instead of vanishing into an untracked write.

### I-0012: XDG-Compliant Vault Path Convention
Cross-repo env var naming for vault/data directories.

**Principle:** Vault content (notes, evidence, run data) → XDG_DATA_HOME. Config → XDG_CONFIG_HOME. Cache → XDG_CACHE_HOME. No project hardcodes `$HOME/vault`.

**Resolution order (per project, first non-empty wins):**
- `arc-agents`  → `$ARC_VAULT_HOME` → `$XDG_DATA_HOME/arc/vault` → `$HOME/.local/share/arc/vault` → `$HOME/vault`
- `ke`          → `$KE_VAULT_HOME`  → `$XDG_DATA_HOME/ke/vault`   → `$HOME/.local/share/ke/vault`   → `$HOME/vault/ke`
- `pipeliner`   → `$PIPELINER_VAULT_HOME` → `$XDG_DATA_HOME/pipeliner/vault` → `$HOME/.local/share/pipeliner/vault` → `$HOME/vault/pipeliner`
- `cli-proxy`   → `$CLI_PROXY_VAULT_HOME` → `$XDG_DATA_HOME/cli-proxy/vault` → `$HOME/.local/share/cli-proxy/vault` → `$HOME/vault/cli-proxy`

**Config dirs:** `$XDG_CONFIG_HOME/<project>/` (e.g. `$XDG_CONFIG_HOME/arc/`). `$ARC_CONFIG` already honors XDG_CONFIG_HOME (U-0005).

**Ledger DB (arc-agents only):** `$ARC_LEDGER_DB` → `$ARC_VAULT_HOME/ledger.db` → `$HOME/vault/ledger.db`.

**Rationale:** Separating data/config/cache avoids dotfile pollution, enables OS-level XDG enforcement (AppArmor, Flatpak sandboxing), and makes vault portable between projects. `$ARC_CONFIG` already follows this pattern.

**Files needing migration (cross-repo):**
- `arc-agents/bin/vast-lease.ts` — `VAULT_DIR` → `ARC_VAULT_HOME`
- `arc-agents/bin/report-error.sh` — `VAULT_DIR` → `ARC_VAULT_HOME`
- `ke/bin/knowledge-engine.ts` — `VAULT_DIR` → `KE_VAULT_HOME`
- `ke/bin/ke-tool.ts` — `KE_ROOT` split into `KE_VAULT_HOME` + `KE_CONFIG_HOME`
- `pipeliner/examples/blog-publish.ts` — hardcoded `$HOME/vault` → `PIPELINER_VAULT_HOME`

### I-0013: Ledger DB XDG Path
`open()` in `src/ledger/db.ts` uses `resolveLedgerDb()` from `src/ledger/ux-config.ts`.
`resolveLedgerDb()` resolves `$ARC_LEDGER_DB` → `$ARC_VAULT_HOME/ledger.db` → `$HOME/vault/ledger.db`.
Pre-existing installs with `ARC_LEDGER_DB` unset and no XDG migration continue working via legacy fallback.

### I-0014: Structural Classifier + In-Place Review Gate
After the diff-review gate for PR/local-sha merges (I-0008) and the in-place evidence requirement (bin-ledger-ts-restrict-in-place-to-requi), the merge-truth slice closes two remaining worker-self-triage attack surfaces:

**Failed classifier is structural, not prose-driven.** `classifyFailed` in `src/ledger/failed-classifier.ts` keys OFF structured event kinds — `LOW_RISK_EVENT_KINDS = {test-fail, budget-blocked, tool-fail, timeout}` — emitted by the harness. Worker-authored text (title, body, `evidence_md`, event payloads) is never consulted: substring-matching on prose let a worker write "the test failed" and steer themselves into auto-decompose. Type-based safety still applies: `type ∈ {HITL, security}` always escalates to needs-HITL (the row's static contract is the second trustworthy signal). Unclassifiable rows default to needs-HITL — PRD enforce-merge-truth-code-verified-eviden user story 7 ("silent auto-decompose cannot swallow real bugs"). Extending `LOW_RISK_EVENT_KINDS` is a code-level change, not a config knob, on purpose.

**`--in-place` requires an independent `in_place_review` event.** `bin/ledger.ts update --state merged --in-place` looks up the LATEST `kind=in_place_review` event for the row (NOT `diff_review` — the two kinds are structurally separate, slice failed-classifier-keys-off-structured-ev). The event must parse as JSON `{reviewer_identity, justification}` with both non-empty strings, `justification ≤280 chars` (same ceiling as `--evidence` on the same flag — bounded length punts long ghost-merge essays), and `reviewer_identity` differs from the row's `claimed_by` (same independence rule as I-0008, shared via `checkReviewerIndependence`). The 280-char `--evidence` note is retained as an operator hint but is no longer the sole gate (PRD §"In-place route"). Parser + independence checker live in `src/ledger/in-place-review.ts`; bookie rule #9 mirrors the refusal.

Migration `029_event_kind_classifier_and_inplace_review` adds the four new kinds (`in_place_review`, `test-fail`, `tool-fail`, `timeout`) to the `issue_events.kind` CHECK via the same table-rebuild pattern as migrations 013/014/018/026. Pre-existing events are carried forward 1:1.

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
