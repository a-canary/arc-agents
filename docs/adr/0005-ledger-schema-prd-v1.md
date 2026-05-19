# ADR 0005 — Ledger Schema for PRD-v1 (kind/class/urgency split, polymorphic deliveries)

**Status:** Accepted (2026-05-19). Migration `011_class_urgency_schema` already merged; this ADR is the retroactive long-form record per `U-0008`.

## Context

The pre-PRD-v1 `issues` table carried a single `type` column that conflated three orthogonal concerns:

1. **What sort of row this is** (a task to execute, a chat event delivered into a thread, a reply emitted out of one, a PRD anchor, …).
2. **Why the work matters** (bug, MVP scope, hygiene, trust/security, scale, efficiency, …) — the *class*.
3. **How soon it must run** (interactive, nominal, deferred) — the *urgency*.

Cramming all three into `type` produced rows like `type=interactive` (urgency-flavoured), `type=mvp` (class-flavoured), and `type=cron` (kind-flavoured). The factory's ready-queue ordering and the interviewer's intake decomposition both wanted to slice on these dimensions independently — and couldn't.

Separately, the chat module had grown two parallel kinds (`chat_in`, `chat_out`) plus an `encounter_reply` kind for HITL flows. Each new delivery surface (encounters, hitl_prompts, future modules) was tempted to mint its own `kind`. The set was unbounded by construction, which broke CHECK-constrained validation and made `idx_issues_ready` partial indexes incoherent.

`G-0001` ("Ledger Schema is Canon") implies any schema change requires a CHOICES update; in practice the migration also warrants an ADR because it is hard to reverse (data backfill) and shapes every future module that delivers rows into the ledger.

## Decision

Split `type` into three orthogonal columns and normalize delivery kinds:

1. **`kind` enum** (CHECK-constrained): `task | event | reply | prd | prefetch`.
   - `chat_in` and `encounter_reply` collapse to `event` (inbound delivery into a thread).
   - `chat_out` collapses to `reply` (outbound delivery from a worker).
   - Module identity moves to a new `source_module` column (e.g. `arc-chat`, `arc-encounter`, future modules), required when `kind IN ('event','reply')`.
2. **`class` enum**: `BUG | MVP | ops | hygiene | quality | trust | scale | efficiency | class_unset`. Captures *why* the work matters. `class_unset` is the explicit "not yet triaged" sentinel; new rows default here.
3. **`urgency` enum**: `interactive | nominal | deferred`. Captures *how soon*. Defaults to `nominal`.
4. **`type` column retained** post-migration for one release as a backstop. Drop deferred until backfill is verified across all live ledgers (implementation note 9 below).
5. **`idx_issues_ready`** rebuilt as `(state, kind, urgency, class) WHERE state='ready'` so the factory's ready-queue scan slices on the new dimensions without a full table scan.
6. **Cascade-on-merge trigger** (`unblock_dependents`, `G-0003`) rebuilt unchanged in shape; the rebuild is mechanical because the table is rewritten via `INSERT...SELECT`.

Migration is `011_class_urgency_schema` in `src/ledger/migrate.ts`. Backfill is table-driven and idempotent inside a single transaction.

## Alternatives considered

- **Keep `type` as a single column, add a parser.** Rejected: every read site would carry the conflation; CHECK constraints couldn't enforce the orthogonal invariants; the ready-queue index couldn't be ordered usefully.
- **Free-form `kind` (no enum).** Rejected: invites a new kind per module and a combinatorial CHECK list. The whole point of `source_module` is that the *delivery shape* is polymorphic across a small fixed kind set, while the *module* is the open-ended dimension.
- **Add `class`/`urgency` but leave delivery kinds untouched.** Rejected as a half-step: would still have `chat_in`/`chat_out`/`encounter_reply` proliferating, and the next module (`arc-deliveries` per ADR 0006) would have minted two more kinds.
- **Drop `type` immediately in the same migration.** Rejected: too many in-flight rows and tests reference `type` directly. One-release deprecation window is cheap insurance; cost is one extra column in the rebuild.
- **Per-module satellite tables (one per delivery surface).** Rejected: defeats `G-0001` ("ledger is canon") and the bookie-as-sole-writer invariant. The ledger stays one table; modules differ by `source_module`.

## Consequences

**Positive.** The factory's ready-queue can prioritize on `(urgency, class)` cleanly. Decomposition can set `class` at create time (the intake skill is the natural triage point). New delivery modules add a `source_module` value rather than a new `kind` — a closed enum stays closed. CHECK constraints catch malformed rows at insert time. `source_module IS NOT NULL` is enforced for `event`/`reply` rows, so polymorphic deliveries can't be ambiguous about origin.

**Negative / costs.** Migration rewrites the `issues` table (`INSERT...SELECT` into `issues_new`, drop, rename). On large ledgers this is an O(N) write under a transaction. WAL mitigates but doesn't eliminate the pause; ledgers should be quiescent (no live writers) during migration. The `type` column lingers until the deferred drop migration — a small per-row storage cost and a footgun for code that reads `type` instead of the new fields.

**Trade-off taken.** Schema clarity and indexable orthogonal dimensions are bought at the cost of one rewrite migration plus a deferred drop. The win compounds with every new module and every ready-queue improvement; the cost is one-time.

## Implementation notes

1. Migration id is `011_class_urgency_schema`; idempotent via `schema_migrations` row.
2. Backfill mapping (`type` → `(class, urgency)`): `interactive → (class_unset, interactive)`, `HITL → (class_unset, nominal)`, `mvp → (MVP, nominal)`, `security → (trust, nominal)`, `quality → (quality, nominal)`, `scale → (scale, nominal)`, `efficiency → (efficiency, nominal)`, `deferred → (class_unset, deferred)`, `cron → (ops, nominal)`.
3. Kind rename: `chat_in`/`encounter_reply` → `event`; `chat_out` → `reply`.
4. `source_module` backfill: `arc-chat` for the renamed chat kinds; `NULL` otherwise (other producers backfill their own rows post-migration).
5. Pre-migration normalization clamps any stray `type` value to `mvp` to satisfy the rebuild's CHECK on the retained `type` column.
6. Indexes rebuilt: `idx_issues_ready`, `idx_issues_thread`, `idx_issues_parent`, `idx_issues_claimed_at`. Order matters — drop before rebuild to avoid CHECK-validation against the old table.
7. Trigger `unblock_dependents` recreated unchanged. The ready-cascade semantics (`G-0003`) are preserved.
8. Test coverage: `bin/ledger.test.ts` includes "claim + spawn-ready surface event-kind rows (ADR 0005 allowlist)" as the regression anchor.
9. **Deferred follow-up:** drop the `type` column once no live ledger row or in-tree code reads it. Tracked as a future CHOICES/ADR delta; not in scope here.
10. CHOICES anchor: `G-0001` mentions `kind`/`type`/`state` as CHECK-constrained enums; that line is accurate post-migration but elides `class`/`urgency`. A CHOICES touch-up may follow if the omission causes confusion.
