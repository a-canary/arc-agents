# ADR 0006 — Deliveries Module: Polymorphic HITL Fanout, Artifact Storage, Pusher Contract, Vacuum GC

**Status:** Accepted — 2026-05-19

## Context

ADR 0002 (UX Module Contract) established the two-table HITL schema (`hitl_prompts` + `hitl_deliveries`) and the broadcast/first-reply-wins/retract pattern. What it did **not** pin down is the *delivery* surface itself — the polymorphic boundary every UX module (`arc-tui`, `arc-webui`, `arc-discord`, `arc-email`, future modules) sits behind. As the second and third reference modules came online, several decisions kept getting re-litigated in CHOICES entries and inline TODOs:

1. **What exactly is a "delivery"?** A row, yes — but is it a passive record the module consumes, or an active obligation the module must drain? The answer shapes both module code and bookie validation.
2. **Where do artifact bytes live?** ADR 0002 mentioned `~/vault/artifacts/<uuid>.*` in passing; the contract around lifetime, addressability, and cleanup was never written down. Modules started inventing their own conventions (Discord's rasterizer cached PNGs in `/tmp`; webui served from the worktree).
3. **What does an async module's pusher daemon owe the harness?** Heartbeat cadence, retraction semantics on network failure, and the boundary between "module is alive" and "module is reachable" were ambiguous. Pusher = liveness or pusher ⊆ liveness?
4. **Who garbage-collects?** `hitl_deliveries` rows accumulate forever; orphaned artifacts in `~/vault/artifacts/` accumulate forever; the `vacuum` ledger verb exists (`I-0001`) but its semantics for deliveries + artifacts was never spelled out.

Many in-flight tasks (the `adr-0006-*` chain) reference "ADR 0006" as anchor reading per `U-0008`, but no such ADR file exists. This is that ADR.

Scope: this ADR is **descriptive** of the consolidated design that emerged from `U-0001`..`U-0007` and clarifies four points where ADR 0002 stopped short. It does not introduce new mechanisms — those would warrant separate ADRs.

## Decision

### 1. Deliveries are polymorphic per (medium, artifact-type)

A `hitl_deliveries` row is a typed obligation: render this `(prompt_id, module_name)` in the module's medium, using the module's declared render strategy for each artifact in the prompt's payload. The row is the unit of accounting; the module's `render`/`retract` operations (ADR 0002 §"operations on a delivery row") are the unit of work.

"Polymorphic UX" = one prompt produces N deliveries, each rendered in a different medium with a different strategy (`native` / `rasterize-png` / `ascii-degrade` / `truncate-codeblock` / …), all coordinated through the same two rows in SQLite. The module is the polymorphism site; the harness stays type-agnostic.

The bookie's pre-write check (already in ADR 0002 §"Bookie validation") gains one explicit guarantee: **every artifact in `payload.artifacts[]` must be renderable (or degradable) by at least one alive module, and every alive module that `implements:` the verb must have a render strategy for every artifact** (no silent partials). If a module declares `unsupported` for an artifact type in the payload, no delivery row is written for that module — but the prompt is still allowed iff some other alive module can render it.

### 2. Artifact storage: addressable, write-once, ref-counted by deliveries

Artifacts >4KB live at `~/vault/artifacts/<sha256>.<ext>` (content-addressable, not uuid-addressable as ADR 0002 sketched). Write-once: the interviewer computes the hash, writes if absent, and embeds the hash in `payload.artifacts[]`. Modules read by hash. Identical artifacts across prompts share storage for free.

Lifetime: an artifact file is **reachable** while at least one `hitl_deliveries` row references it (transitively via `prompt_id → payload.artifacts[]`). The `ledger vacuum` verb GCs unreachable artifacts (see §4).

Module-local rendered byproducts (e.g. Discord's rasterized PNG of a `diagram/mermaid` source) are the module's business — they live wherever the module wants and are not the harness's problem. The contract is: canonical artifact in `~/vault/artifacts/`, by hash; everything downstream is module-internal.

### 3. Pusher contract for async modules

Async modules (Discord, email, anything that pushes to a remote API) ship a `pusher` daemon declared in `config.ux_modules[].pusher`. The contract:

- **Heartbeat is the pusher's responsibility.** When the pusher is up and the remote API is reachable, it heartbeats every `heartbeat.interval_sec`. The module is "alive" iff its most recent heartbeat is younger than `heartbeat.stale_after_sec`.
- **Liveness conflates reachability and process-up.** If Discord's API is down for >`stale_after_sec`, the module goes stale and the bookie refuses new HITL writes that depend on it (same path as the module being uninstalled). This is intentional: a write the user won't see is worse than a write that fails loudly.
- **Pushers own delivery state transitions.** `pending → delivered` happens when the pusher confirms the remote side acked the render (e.g. Discord returned a message id). `delivered → retracted` happens when the pusher confirms the remote-side retraction (e.g. message edited/deleted). `delivered → failed` is the pusher giving up after its own retry policy — the harness has no retry policy of its own.
- **The harness never opens a socket to a remote service.** Reaffirms ADR 0002. The pusher is the only process that talks to the remote API; the harness only writes ledger rows and reads heartbeats.

Sync modules (TUI, webui) have no pusher; they poll the ledger directly. `pusher` is null in their config.

### 4. Vacuum GC: deliveries, artifacts, and prompt cascades

`ledger vacuum` (existing verb, `I-0001`) becomes the single GC entry point. It runs three passes in one transaction:

1. **Terminal-prompt sweep.** `hitl_prompts` rows where `state IN ('answered','timeout_locked','cancelled')` and `answered_at < now() - retention_sec` (default 30 days) are deleted along with their `hitl_deliveries` rows (`ON DELETE CASCADE`).
2. **Orphan-delivery sweep.** Any `hitl_deliveries` row whose `prompt_id` no longer exists is deleted. (Belt-and-suspenders; the cascade above handles the common case.)
3. **Unreachable-artifact sweep.** Walk `~/vault/artifacts/`, compute reachable set = `{hash : hash ∈ any live hitl_prompts.payload.artifacts[]}`, unlink the difference.

After all three, run SQLite `VACUUM` (reclaims pages). The verb is idempotent and safe to run on a live ledger because each pass uses its own atomic transaction and modules tolerate `retracted`-then-deleted as the same end state.

Cadence is operator-driven (manual or cron); the harness does not run `vacuum` on a timer. `I-0001` already gates `vacuum` as a maintenance verb, not a runtime hot path.

## Why not alternatives

**UUID-addressable artifacts.** Loses dedup. Two prompts with the same mermaid source would write the source twice and the rasterized PNG twice across modules. Content-addressing pays for itself the first time the interviewer regenerates a chart from identical data.

**Module-managed artifact stores (each module owns its bytes).** Couples canonical content to the medium. A user replying in Discord to a prompt that has a markdown attachment would have to fetch from Discord's storage to see what they replied to. Vault is the canon; modules are render surfaces.

**Per-delivery retry policy in the harness.** Pushers know their remote APIs (Discord has rate limits, email has SPF, Slack has different quotas). The harness shouldn't second-guess. `delivered → failed` is the pusher's call.

**Reference-count column on artifacts.** Tempting, but invalidates on every prompt write/delete. The scan-on-vacuum cost is fine for the artifact volumes a solo dev produces; we'll revisit if/when the artifact dir exceeds 100k files.

**Cascade-delete prompts immediately on `answered`.** Loses the audit trail. The 30-day retention exists so the user can scroll back at `arc-chat` and see what they replied to last week. Tunable per deployment.

**Make `vacuum` automatic on a timer.** Adds a daemon. The harness already has only one always-on daemon (factory); adding a vacuum daemon for what is fundamentally maintenance is a poor trade. Cron or manual is fine.

## Out of scope

- The exact retention window per prompt class (taste vs impact may want different defaults). Filed for a follow-up CHOICES entry, not this ADR.
- Per-module artifact prefetch/cache invalidation (module-internal).
- A `hitl_artifacts` table (currently artifacts are referenced from `payload.artifacts[]` JSON, scanned at vacuum). Promote to a table only if scan cost becomes a problem.
- Cross-host vault replication for artifacts (single-host assumption holds; `A-0004` keeps the vault local).

## Consequences

- Module authors have one canonical place to read about delivery semantics. The `adr-0006-*` task chain now has anchor reading per `U-0008`.
- `hitl_deliveries` schema gains no new columns; this ADR is documentation-only for the existing schema (ADR 0002 §"Schema").
- Bookie's pre-write check is the enforcement site for §1's "no silent partials" rule — already where the alive-module check lives, no new code path.
- `ledger vacuum` becomes the documented GC story (no separate `prune` verb). The verb already exists; this ADR pins its semantics.
- Future modules slot in by declaring config + writing `render`/`retract` + (if async) a pusher. The contract is closed; nothing new gets added to the harness per module.
