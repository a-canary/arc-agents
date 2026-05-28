# ADR 0002 — UX Module Contract

**Status:** Accepted — 2026-05-16

## Context

The arc-agents harness has no built-in UX. Interviewer and workers need to surface HITL prompts to the user — choices, confirmations, free-text questions, notifications, artifacts — but the *medium* (browser, Discord, terminal, email) is intentionally pluggable.

The first cut at this was ad-hoc: a planned `arc-webui` would call into the harness, the harness would push HITL packets to it, schemas would grow per-medium. That design conflated three concerns:

1. **What** the interviewer wants to ask (kind, payload, artifact).
2. **How** the harness reaches the user's medium (transport, auth, retry).
3. **Which** medium renders right now (and what to do when multiple are alive, or none).

Conflation meant every new module (Discord, TUI, email) would bring its own transport spec into the harness, and the harness would accumulate per-medium adapter code. The interviewer's prompt vocabulary also leaked into transport: "render a mermaid diagram" meant different things for webui vs Discord vs ASCII terminal, and nothing forced the agent to produce one canonical form.

Additionally, the original HITL model assumed every prompt blocks. In practice the solo-dev workflow has two very different HITL classes — cosmetic taste choices (60s timeout, speculatively continue) and load-bearing impact decisions (hard block) — and forcing both through one blocking flow either wastes time or risks shipping changes the user hasn't approved.

## Decision

The harness defines a **UX Module Contract**: a small set of skills (verbs) the interviewer calls, a typed set of artifacts modules render, and a two-table ledger schema for HITL state. Modules are external installables that fulfill the contract; the harness owns no transport code.

### Delivery patterns by medium class

- **Sync mediums** (TUI, webui): user is *at* the surface, surface is *at* the machine. Module polls the ledger directly (or subscribes via SQLite update_hook / inotify on the db file). No middleman.
- **Async mediums** (Discord, email): user is remote, surface is remote. The module ships its own **pusher daemon** that watches the ledger and forwards to the remote API, and polls inbound for replies. The pusher is part of the module, not the harness.

The harness only ever sees ledger rows; it never opens a socket to a UX surface.

### Two HITL classes

| | taste | impact |
|---|---|---|
| examples | button color, log format, copy tone | deploy approval, schema migration, security trade-off |
| timeout | 60s (configurable per prompt) | none |
| recommendation written at create | yes | no |
| dependent work | proceeds speculatively against recommendation | blocks (`state=blocked`) |
| on timeout | locks recommendation as answer | n/a |
| on divergent user reply | reconcile (see strategies) | unblock dependents with answer |

A worker may emit `class=taste` directly — the shim returns the recommendation immediately, so the worker isn't actually blocked.

A worker **must not** emit `class=impact`. Per `CONTEXT.md`, workers that hit a blocker decompose into HITL children and exit. The shim enforces: `class=impact` from a non-interviewer role errors.

### Speculative execution + divergence reconciliation

When a `class=taste` prompt is created, the harness captures a **single anchor** — `(repo, branch, HEAD sha)` at insert time. The worker that emitted the prompt continues against the `recommended` answer.

On reply:

- Reply matches `recommended` → `state=user_confirmed`. No-op.
- Reply differs → `state=user_diverged`. Reconcile per the prompt's `divergence_strategy`:
  - **`forward_fix`** (default): spawn a new task "apply alternative <answer> to work descended from <anchor>". Cheap, append-only, can't corrupt history.
  - **`replay`**: walk forward from `anchor_commit` on `anchor_branch`, reset, re-run dependent tasks with the new answer. Requires `G-0005` (one slice per worktree per commit) to hold — and it does.
- Timeout → `state=timeout_locked`, `answer = recommended`.

No per-commit `speculative-on:` trailers, no `hitl_dependencies` table. The anchor is sufficient because `G-0005` guarantees the worker is the only writer on its branch between anchor and HEAD.

To keep anchors unambiguous, `class=taste` prompts are **serialized per worktree**: a second taste prompt on the same worktree blocks until the first resolves. Cross-worktree taste prompts may run concurrently.

### Module contract — verbs

The interviewer (or a worker, for `class=taste`) calls these via the `arc-ux` CLI shim:

- `ux.ask_text(prompt) → string`
- `ux.ask_choice(prompt, options[]) → option`
- `ux.ask_confirm(prompt) → bool`
- `ux.notify(message, level)` — broadcast, fire-and-forget
- `ux.show_artifact(artifact)` — pass typed artifact, module renders or degrades

`arc-ux` is a thin wrapper:

1. Resolves `class` (`taste` | `impact`), `recommended` (for taste), and the anchor (`git rev-parse HEAD` in cwd, if taste).
2. Inserts `hitl_prompts` row via bookie (the only ledger write path).
3. Inserts one `hitl_deliveries` row per alive UX module.
4. For `class=impact`: blocks on `wait-for-ledger --id=<id> --until state=answered`.
5. For `class=taste`: returns `recommended` immediately. A background reconciler watches for `state=user_diverged` and triggers `forward_fix` or `replay`.

### Module contract — artifacts

The interviewer produces artifacts in a canonical, medium-agnostic type. Conversion is the module's job.

Canonical artifact types:

- `text/markdown`
- `text/diff` (unified)
- `chart/vega-lite` (spec)
- `diagram/mermaid` (spec)
- `image/png` (bytes by reference)
- `table/rows` (json)

Each module declares per type: `native` | one of (`rasterize-png`, `ascii-degrade`, `html-degrade`, `truncate-codeblock`, …) | `unsupported`. If `unsupported`, the harness skips delivering that artifact to that module; if all alive modules are unsupported, the bookie refuses the write (same path as no-alive-module).

Artifacts >4KB live at `~/vault/artifacts/<uuid>.{png,svg,md,…}`; the `payload.artifacts[]` field holds refs, not bytes.

### Module contract — operations on a delivery row

Each module implements two operations against `hitl_deliveries`:

- **`render(delivery)`** — show the prompt in the medium, store `external_ref` (e.g. Discord message id, webui dom id), mark `state=delivered`.
- **`retract(delivery)`** — undo the render (edit/delete external message, hide UI element), mark `state=retracted`. Optional per `can_retract` capability — email modules `state=retracted` without action.

Cross-medium reflection (broadcast + first-reply-wins):

1. Interviewer calls `ux.ask_choice`. Bookie inserts 1 `hitl_prompts` + N `hitl_deliveries` (one per alive module).
2. Each module renders, sets `state=delivered`, stores `external_ref`.
3. User replies in module X. Module X writes via the `ledger` CLI:
   `UPDATE hitl_prompts SET state=answered, answer=?, answered_by='X' WHERE id=? AND state=open` (atomic — first wins).
4. SQL trigger (or `ledger tick`) flips deliveries `WHERE prompt_id=? AND state=delivered AND module_name != 'X'` to `state=retracted`.
5. Each loser module sees its delivery flipped → calls `retract`.

### Configuration

`~/.config/arc/config.yaml` is the declarative contract:

```yaml
ux_modules:
  - name: arc-tui
    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]
    renders:
      text/markdown: native
      text/diff: native
      diagram/mermaid: ascii-degrade
      chart/vega-lite: ascii-degrade
      table/rows: native
    can_retract: true
    cli: arc-tui                 # binary on PATH
    heartbeat: { interval_sec: 60, stale_after_sec: 300 }

  # arc-webui: lives at arc/packages/arc-webui (arc-framework monorepo).
  # Config example removed — see that package's own ADR.

  - name: arc-discord
    implements: [ask_text, ask_choice, ask_confirm, notify]
    renders:
      text/markdown: truncate-codeblock
      text/diff: truncate-codeblock
      diagram/mermaid: rasterize-png
      chart/vega-lite: rasterize-png
      image/png: native
    can_retract: true            # edits its own bot message
    cli: arc-discord
    pusher: arc-discord-pusherd  # daemon owned by module
    heartbeat: { interval_sec: 60, stale_after_sec: 300 }
```

Config = what should exist (declarative contract). Ledger = what is alive (liveness via heartbeats). No transport, auth, or endpoint fields in config — those are the module's internal business.

### Bookie validation

Before creating a `hitl_prompts` row, the bookie checks:

- `config.ux_modules` non-empty AND ≥1 module has heartbeat <`stale_after_sec` old AND ≥1 alive module `implements:` the requested verb AND can render every artifact in the payload.
- If false: refuse the write. Atomically create a bootstrap task instead — `type=mvp`, `kind=task`, body: "install a UX surface module" (or "UX module <name> heartbeat stale" / "no alive module implements <verb>"). The interviewer surfaces it via stderr in its own pane (the always-available fallback) until a real module is alive.

### Schema

```sql
CREATE TABLE hitl_prompts (
  id                   INTEGER PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN
                         ('ask_text','ask_choice','ask_confirm','notify','show_artifact')),
  class                TEXT NOT NULL CHECK (class IN ('taste','impact')),
  payload              TEXT NOT NULL,                    -- zod-validated json per kind
  recommended          TEXT,                             -- nullable; required when class='taste'
  divergence_strategy  TEXT CHECK (divergence_strategy IN ('forward_fix','replay')),
  timeout_sec          INTEGER,                          -- 60 default for taste, null for impact
  state                TEXT NOT NULL CHECK (state IN
                         ('open','timeout_locked','user_confirmed','user_diverged',
                          'answered','cancelled')),
  answer               TEXT,
  answered_by          TEXT,                             -- module name, null on timeout_lock
  answered_at          INTEGER,
  anchor_repo          TEXT,                             -- taste only
  anchor_branch        TEXT,
  anchor_commit        TEXT,
  expires_at           INTEGER                           -- null for impact
);

CREATE TABLE hitl_deliveries (
  prompt_id      INTEGER NOT NULL REFERENCES hitl_prompts(id),
  module_name    TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN
                   ('pending','delivered','retracted','acked','failed')),
  external_ref   TEXT,
  delivered_at   INTEGER,
  retracted_at   INTEGER,
  PRIMARY KEY (prompt_id, module_name)
);
```

Per-kind `payload` shape is enforced by zod schemas in `src/ledger/hitl-schemas.ts`, imported by both the bookie and the modules.

## Why not alternatives

**Push to modules from the harness.** The harness would have to own transport, auth, retry, backpressure per medium. Every new module bloats the harness. Pull (sync) + module-owned pushers (async) keeps the harness transport-free.

**One table for prompts + deliveries (deliveries as JSON column).** Fan-out and retract become JSON manipulation across many child entries; same reasoning as `issues` + `issue_events` already in the schema. Two tables, real joins.

**Block on every HITL.** Solo-dev workflow can't afford 60s blocks on cosmetic choices. Speculative execution against `recommended` is what unblocks the AFK loop; `forward_fix` makes divergence cheap.

**Tag every speculative commit with `speculative-on: <prompt_id>`.** Discipline-dependent — one untagged commit breaks replay. The single-anchor model gets the same information from `G-0005` for free.

**Priority field on modules to break ties.** Under the original claim-per-prompt model, priority decided which module rendered. Under broadcast, every alive module renders; "tie-break" is just first-wallclock atomic UPDATE on the user's reply. Priority adds no signal.

**`hitl_dependencies` table (worker writes itself in when consuming a recommendation).** Replaced by the anchor; one row per prompt, not N per consumer. Replay walks git, not the ledger.

## Out of scope

- The shapes of individual `payload` zod schemas (defined in code; this ADR fixes the kinds, not the field-level shape).
- The reconciler daemon's exact implementation (factory-style supervisor likely, but TBD).
- arc-framework/arc/packages/arc-webui/ module internals — see that package's own ADR.
- arc-discord, arc-email module internals — each gets its own ADR if any decision is hard-to-reverse.
- The hygiene cron that motivated this work — built on top of the contract, doesn't constrain it.

## Consequences

- Modules become independently installable/restartable. No harness redeploy when a module ships.
- `arc-tui` is the first reference implementation. Once it works end-to-end the contract is proven; UX module #2 follows the same pattern.
- The contract surface (verbs, artifact types, schema) will mutate as new mediums reveal gaps. This ADR mutates with it — accepted trade-off versus splitting surface into a separate `system/ux-module-contract.md`.
- Bookie gains real validation responsibility beyond schema-shape (alive-module + render-capability checks). Worth it — it's already the single write choke point.
