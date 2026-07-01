# ADR 0012 — Director ownership reverted; arc-agents stays a delegation target

**Date:** 2026-06-30
**Status:** accepted (supersedes the same-day "Director Agent + AXI-conformant ledger" decision)
**Decides:** arc-agents does not instantiate its own "Director"; arc-skills' `/director` is the one mission-owning agent, and arc-agents exposes utilities + a governor it can bind to

---

## Context

Earlier the same day, ADR-0012 (original) proposed a **Director Agent**: a group-owning,
autonomously-driving agent living in arc-agents, steered by typed feedback
(`mode`/`author_trust`), bounded by a `governor`, and delegating solely through
the `ledger` CLI ("AXI"). Supporting modules (`mission-gap`, `director-brief`,
`directorGroupFromCwd`) and CLI wiring landed across PRs #298–#302, with the
ADR (#307) as the docs capstone.

Independently, in `a-canary/arc-skills`, a `/director` skill was designed in
parallel: a real instantiated agent — event-driven with a 12hr cron backstop,
owning mission drive end-to-end (gap-analysis, delegate, verify, gate on
evidence) — explicitly harness-agnostic, with arc-agents as one *optional*
binding target (`task-delegation: arc-agents`) rather than the home of the
driver itself.

Both repos independently grew an agent named "Director" with near-identical
responsibilities, on the same day, with no cross-repo reconciliation.

## Decision

**arc-skills' `/director` is the mission-owning agent.** It instantiates,
runs event-driven with a cron backstop, and owns the mission-drive loop. It
must not depend on arc-agents being installed or operational. arc-agents does
not grow a competing in-repo Director — it exposes data and guards that
`/director` (or anything else) can call into.

**Reverted:**
- The "Director" / "Director Group" concept as a standing, autonomous,
  group-owning agent living *in arc-agents*.
- `directorGroupFromCwd()` and the plural `~/vault/agents/directors/<group>/`
  cwd-routing branch in `src/profiles/select-by-cwd.ts` — removed outright,
  along with their tests. (The legacy singular `~/vault/agents/director/`
  route, used for arc-agents' own session-profile selection, is unrelated and
  untouched.)
- TOON as the default or implied output encoding. arc-agents CLI output stays
  JSON by default; `--csv` / `--md` are acceptable opt-in renders. No TOON.

**Replaced — "Director Group" → parent-repo construct:**
A vault path no longer designates which repos one driver owns. Instead: the
**parent repo** is wherever `/director`'s own state lives (`.arc/director/`),
and `<parent-repo>/AGENTS.md` declares the bindings for the repos it manages
(`task-delegation`, `workspace`, `budget`, etc.). This is arc-skills' concern,
not arc-agents' — arc-agents has no code representing "which repos a Director
owns" anymore.

**Changed — Governor is now a standalone, per-repo-budgeted util:**
- `bin/director-governor.ts` no longer derives sentinel paths from
  `~/vault/agents/directors/<group>/`. The caller supplies `sentinelDir`
  directly (e.g. `<parent-repo>/.arc/director/`).
- `weeklyBudget` is renamed `repoBudget` and is now a real per-repo parameter
  — repo-a can declare 100k tokens/week, repo-b 500k, each via its own
  `AGENTS.md` `budget` binding feeding the CLI's `--weekly-budget` flag.
- **Known gap, not solved here:** codeburn's export is still a *host-wide*
  weekly token sum — there is no per-repo spend *attribution* today, only a
  per-repo *threshold*. Two repos with different budgets trip at different
  points, but neither sees isolated spend yet. Fixing this needs spend tagged
  by repo/session at the source (codeburn or equivalent) — tracked as a
  follow-up.
- **Verdict shape changed:** going over budget used to hard-stop all new
  work. Now `restrictTo: "critical-only"` — ordinary spawns pause, but
  `/director`'s own bypass triggers (`qa.failed` with `dimension:
  critical-failure` or `dimension: security`) may still proceed. This mirrors
  arc-skills' `/director` budget binding, which already had this bypass
  concept; the governor now exposes the same distinction instead of an
  all-or-nothing gate.
- Renamed `allowDirector` → `allowCaller` in the verdict shape, since the
  governor guards any caller, not specifically a "Director."

**Kept, reframed as plain arc-agents-local utilities (no behavior change beyond the above):**
- `src/director/mission-gap.ts` (`gaps()`) — pure goal/ledger diff, capped
  proposals. Called by `/director`'s gap-analysis step.
- `src/director/director-brief.ts` (`brief()`) — pure done/current/next
  partitioner. Same function, same signature.
- `bin/ledger.ts director-brief` CLI verb — stays wired; `/director` is the
  caller.

**Deferred — separate PRD required:**
- The AXI protocol itself (what `ledger <verb>` surface is a stable contract,
  what isn't, non-TTY output shape) was asserted by the original ADR-0012 but
  never independently analyzed. Treat it as provisional.
- Per-repo token *attribution* (vs. the per-repo *threshold* shipped here) —
  needs codeburn or equivalent to tag spend by repo/session.
- Steering typing (`mode: imperative|hypothesis`, `author_trust`) on feedback
  rows is unaffected by this revert — it's a property of the ledger's
  feedback table, not of who owns the driver. Left as-is, not evaluated here.

## Consequences

### Positive
- One mission-owning agent (`arc-skills/director`), not two divergent
  implementations racing on the same problem in different repos.
- arc-agents keeps the small, pure, already-tested utilities (`mission-gap`,
  `director-brief`) and the governor, now correctly scoped as guard/data
  providers rather than owners.
- Governor's budget is now genuinely per-repo-configurable (the threshold
  half of that, at least) — directly addresses "should repo-a and repo-b be
  able to have different weekly budgets," which the original host-wide-only
  design could not do.
- Over-budget no longer fully halts a repo — critical-failure/security work
  still gets through, matching `/director`'s own bypass semantics instead of
  conflicting with them.

### Negative
- `docs/adr/0012-director-agent-axi.md`'s original content is gone from the
  default branch (recoverable from git history at `2336648`); anything that
  linked to it as "the" Director design is now stale and needs to point at
  `a-canary/arc-skills`'s `/director` SKILL.md instead.
- `directorGroupFromCwd()` removal is a breaking API change for any caller
  that depended on it (none found in this repo at revert time — only its own
  test file referenced it).
- The AXI protocol and per-repo token attribution both ship today without
  the dedicated analysis/implementation pass this ADR defers — known gaps,
  not regressions introduced here.

### Open
- Should `mission-gap`/`director-brief`/`governor` move under a more neutral
  path than `src/director/` now that they're not Director-owned? Cosmetic;
  left for the AXI follow-up PRD.
- Per-repo token attribution implementation — needs its own design pass
  (codeburn session tagging, or a different spend-tracking source entirely).

## Addendum (same day) — `profiles/director.json` deprecated as a planner

`profiles/director.json` was arc-agents' own pre-existing portfolio
interviewer (UX_1 new-thread intake via `grill-with-docs`, UX_2 HITL,
decomposes intent into ledger rows via bookie) — older than, and a separate
naming collision from, the ADR-0012 series this file otherwise documents.

**Decision:** this profile's role as *the* canonical mission planner is
deprecated. `/director`'s non-AFK interactive mode (grill-me + research,
pause/steer/resume) now covers that interviewer role, standalone — no
arc-agents dependency. `/director` is self-sufficient: it installs its own
feedback watcher and 12hr cron backstop, and plans by default against a
single `PRD.md` file at the parent repo's root (replaced wholesale per
closed gap), not a ledger queue.

**Not removed:** the `agent='director'` ledger enum value, `triageUnset`'s
`kind=prd` → `director` triage rule, `bin/plan.ts`'s PRD-minting flow, and
`profiles/director.json` itself all stay exactly as-is — this is real,
load-bearing PRD-review-gate infrastructure for repos that use arc-agents'
ledger as their planning backend. It is now documented as **one optional
`planning-target` binding** (`planning-target: arc-agents-ledger`) that
`/director` can delegate to, alongside `prd-file` (default) and `kanban` —
see [a-canary/arc-skills](https://github.com/a-canary/arc-skills)' `/director`
SKILL.md. `profiles/director.json`'s `context_summary` was reworded to point
there instead of describing itself as the canonical planner.

**Open:** the user separately raised whether arc-agents' other profiles
(`admin.json`, `sprint.json`, `triage.json`) should similarly be extracted
into standalone skills. Not evaluated or actioned here — flagged for a future
pass, scoped on its own.

## Addendum 2 (same day) — cwd-based role selection retired; arc-agents reframed as a CLI-agent scheduler/failover substrate

**Decision:** `A-0003` (agent selection by cwd, `CHOICES.md`) is superseded.
`src/profiles/select-by-cwd.ts` and its test are deleted — `selectRoleByCwd`
had zero in-repo callers at removal time (only its own test referenced it),
matching the same shape as `directorGroupFromCwd()` in the original revert.
Replaced by: an agent is invoked directly against a repo's root path, and
that repo's own `AGENTS.md` supplies bindings/roles/constraints. No
`~/vault/agents/<role>/` cwd inference anywhere in the model going forward.

**Reframe:** arc-agents' role in this architecture is a CLI-agent scheduler
with cross-provider/cross-model failover — a substitute for a harness's
built-in background-agent and cron scheduling, not a competing mission-owner.
Where a harness would otherwise poll its own cron for `/director`'s 12hr
backstop, arc-agents can instead dispatch that tick to whichever CLI agent
(`claude`, or another provider) is configured in a repo's failover group
(`src/config/load.ts`'s existing `getAliasCommands`/fast-smart alias
mechanism), retrying the next candidate on failure. This is additive to,
not a replacement for, `/director`'s own self-installed cron default
(`scheduler: cron` in arc-skills' `/director` SKILL.md) — `scheduler:
arc-agents` remains the opt-in binding that routes through this substrate
instead.

**Habitual-default framing:** `/director`'s own bindings (event-bus,
task-delegation, workspace, planning-target, scheduler, …) each default to
a flat-file/harness-native behavior (`jsonl`, `native`, `worktree`,
`prd-file`, `cron`) — arc-agents-backed alternatives are enhancements an
`AGENTS.md` binding opts into, not a baseline dependency. This ADR's
Governor, `director-brief`, and (should a repo opt in) scheduling substrate
are all instances of that same enhance-via-binding shape — none is load-bearing
for `/director` to function standalone.

**Not done here:** no new arc-agents code implementing the CLI-agent
dispatch/failover substrate itself — this addendum records the reframe in
scope and intent; implementation is future work, likely warranting its own
PRD given it changes arc-agents' value proposition materially (see the
`scheduler` binding's arc-agents branch in arc-skills' `/director` SKILL.md,
which today only says "factory can schedule and execute the tick instead" —
this addendum is the reasoning behind why that's still true and what it
should grow into).
