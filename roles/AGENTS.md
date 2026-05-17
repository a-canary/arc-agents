# Agent Doctrine — All Roles

Universal habits for every role (developer, director, admin, interviewer, future specialists). Loaded by each role profile's `context_files`. Ported from `~/agents/roles/AGENTS.md` and reshaped for the ledger-dispatched, ephemeral-worker model (see [CHOICES.md](../CHOICES.md) `M-0001`, `M-0004`, ADR 0001/0003).

For the canonical glossary, see [CONTEXT.md](../CONTEXT.md). Decisions are in [CHOICES.md](../CHOICES.md) and [docs/adr/](../docs/adr/).

---

## 1. Evidence-First

Every input is a thesis until verified. That applies to:

- User messages — confirm scope/intent via `grill-with-docs` before decomposing.
- Research output (web fetch, KE recall, another worker's PR description) — verify against code or fresh observation before encoding.
- Ledger event log — a prior `note` event is one worker's claim, not ground truth.

Never write an unverified claim into CHOICES.md, CONTEXT.md, a PR description, or a ledger row body without marking it as a hypothesis (`# hypothesis: ...`) and pairing it with the verification step that would promote it.

CONTEXT.md term: [evidence-first](../CONTEXT.md#evidence-first).

## 2. Concern → HITL Decomposition

When a worker hits a decision outside its CHOICES scope, a risky/irreversible action, or a blocker only a human can resolve: **decompose into HITL children, don't guess and don't stall**.

The `~/agents/` predecessor wrote `outbox/concern-*.md` files for this. In arc-agents the mechanism is the ledger:

1. Worker writes N HITL child rows via bookie (recursion allowed, no fanout cap — but if you're past ~5 children the task probably isn't atomic; re-shape instead).
2. Worker sets `parent.blocked_by = [childIds]`, flips `parent.state = blocked`.
3. Interviewer (or `class=taste` worker) emits a `hitl_prompts` row if the decision is user-facing.

Do *not* decompose for decisions inside CHOICES scope, low-risk, reversible work — just act.

CONTEXT.md term: [concern](../CONTEXT.md#concern).

## 3. Pattern Detection & Root-Cause Discipline

One row failing is an observation. The same failure shape across N rows is a **pattern** — a first-class signal.

When you suspect a pattern:

1. Name it in the failing row's event log (`kind=note`, body lists the related issue ids).
2. Search the ledger for the same shape before re-trying the work.
3. Fix the root cause, not the symptom. If the root cause is outside your scope, escalate via HITL decomposition.

The `triage-failed` skill is the director's entry point for cross-row pattern review.

Root cause discipline: keep asking "why" until you reach something actionable and durable. A worker exiting `state=failed` is a symptom. All workers exiting `state=failed` at the same timestamp is a pattern. The factory reaping workers under memory pressure is the root cause. Only the root cause fix eliminates the pattern.

CONTEXT.md term: [pattern](../CONTEXT.md#pattern).

## 4. Leave It Clearer Than You Found It

Every session must reduce ambient confusion. Before AFK shutdown:

- **Update docs on sight** — if you learned a term, add it to CONTEXT.md. If you made a scoped decision, add it to CHOICES.md. If a path/filename/agent-name reference is broken, fix it.
- **Use `to-trash`, not `rm`** — moves to `~/trash/<unix-ts>_<name>-<YYYYMMDD>/` with 30-day retention. Always reversible. (When ported.)
- **`ke-learn` on stop** — the stop hook queues distillation; you don't need to invoke it manually, but you *can* add explicit `# learn: ...` markers in your journal for high-value insights.
- **Commit as the configured git user** — never hardcode (see CHOICES `I-0006`).

Leaving ambiguity for the next session is a defect.

## 5. Session Pattern

Default shape of a worker session:

1. **ke-recall** (auto, via session-start hook) — load relevant KE context.
2. **Read the row** — `bin/ledger.ts show <id>`; read its parent and any blockers.
3. **Read in-scope docs** — CONTEXT.md and the CHOICES sections referenced by the row's `repo`.
4. **Decompose if blocked, else execute** — see §2.
5. **Drive to terminal** — `merged` (with evidence + PR) or `failed` (with evidence), or `blocked` via decomposition. See `claude-afk` skill and `hooks/stop.sh`.
6. **ke-learn** (auto, via stop hook).

## 6. When Confused

Stop. Do not guess.

1. `ke-recall <query>` — search KE for prior decisions.
2. `grep` the journal/events for similar past rows.
3. If still unclear and the decision affects taste or impact, **decompose into HITL** rather than picking silently (§2).
4. Document the assumption in the row's event log before acting.

Confusion acted on silently compounds.
