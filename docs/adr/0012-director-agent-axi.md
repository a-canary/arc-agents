# ADR 0012 — Director ownership reverted; arc-agents stays a delegation target

**Date:** 2026-06-30
**Status:** accepted (supersedes the same-day "Director Agent + AXI-conformant ledger" decision)
**Decides:** arc-agents does not own a standing "Director" concept; the per-conversation Planner is not replaced in-repo

---

## Context

Earlier the same day, ADR-0012 (original) proposed a **Director Agent**: a group-owning,
autonomously-driving agent living in arc-agents, steered by typed feedback
(`mode`/`author_trust`), bounded by a `governor`, and delegating solely through
the `ledger` CLI ("AXI"). Supporting modules (`mission-gap`, `director-brief`,
`directorGroupFromCwd`) and CLI wiring landed across PRs #298–#302, with the
ADR (#307) as the docs capstone.

Independently, in `a-canary/arc-skills`, a `/director` skill was designed in
parallel as a **harness-agnostic mission driver** — same shape (gap-analysis
loop, pause/resume, weekly token budget with bypass, steering via feedback)
but explicitly built to depend on nothing but flat files, with arc-agents as
one *optional* binding target (`task-delegation: arc-agents`) rather than the
home of the driver itself.

Both repos independently grew an agent named "Director" with near-identical
responsibilities, on the same day, with no cross-repo reconciliation.

## Decision

**arc-skills' `/director` is the mission driver.** It is harness-agnostic by
design — it must not depend on arc-agents being installed or operational.
arc-agents does not grow its own competing Director concept.

**Reverted:**
- The "Director" / "Director Group" concept as a standing, autonomous,
  group-owning agent living in arc-agents.
- `directorGroupFromCwd` and `~/vault/agents/directors/<group>/` as a
  *Director-routing* mechanism. (`select-by-cwd.ts` itself may still serve
  other profile-routing needs — not evaluated here.)
- TOON as the default or implied output encoding. arc-agents CLI output stays
  JSON by default; `--csv` / `--md` are acceptable opt-in renders. No TOON.

**Kept, reframed as plain arc-agents-local utilities (no source changes):**
- `src/director/mission-gap.ts` (`gaps()`) — pure goal/ledger diff, capped
  proposals. Useful to *any* external caller, not a self-driving feature.
- `src/director/director-brief.ts` (`brief()`) — pure done/current/next
  partitioner. Same: a utility, not an owner.
- `bin/director-governor.ts` (`governor()`) — pause/kill sentinel + weekly
  token budget guard. This is the rate-limit primitive `/director`'s own
  `budget` binding can shell out to before spawning new work. Explicitly
  requested to stay.
- `bin/ledger.ts director-brief` CLI verb — stays wired; an external driver
  (not an in-repo Director) is the caller.

**Deferred — separate PRD required:**
- The AXI protocol itself (what `ledger <verb>` surface is a stable contract,
  what isn't, non-TTY output shape) was asserted by the original ADR-0012 but
  never independently analyzed. Treat it as provisional. A follow-up PRD
  should evaluate AXI on its own merits, decoupled from the Director-ownership
  question this ADR reverts.
- Steering typing (`mode: imperative|hypothesis`, `author_trust`) on feedback
  rows is unaffected by this revert — it's a property of the ledger's
  feedback table, not of who owns the driver. Left as-is, not evaluated here.

## Consequences

### Positive
- One mission driver (`arc-skills/director`), not two divergent
  implementations racing on the same problem in different repos.
- arc-agents keeps the small, pure, already-tested utilities (`mission-gap`,
  `director-brief`, `governor`) without the lock-in of owning the loop that
  calls them.
- No source/test deletion — the revert is documentation and framing only;
  rollback risk is near zero.

### Negative
- `docs/adr/0012-director-agent-axi.md`'s original content is gone from the
  default branch (recoverable from git history at `2336648`); anything that
  linked to it as "the" Director design is now stale and needs to point at
  `a-canary/arc-skills`'s `/director` SKILL.md instead.
- The AXI protocol ships today without the dedicated analysis pass this ADR
  defers — known gap, not a regression introduced here.

### Open
- Should `mission-gap`/`director-brief`/`governor` move under a more neutral
  path than `src/director/` now that they're not Director-owned? Cosmetic;
  not blocking, left for the AXI follow-up PRD.
- Does `directorGroupFromCwd`'s `~/vault/agents/directors/<group>/` path
  convention get renamed, or does it stay as a harmless legacy path the
  Governor still reads from? Left as-is for now — functional, just no longer
  description-accurate as "Director" storage.
