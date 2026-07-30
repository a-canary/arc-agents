# ADR 0013 — `issue → ticket`, `prd → spec` migration

**Status:** accepted (2026-07-30)
**Date:** 2026-07-30
**Decides:** Whether the arc-agents ledger substrate renames its row noun (`issue → ticket`) and its design-document kind (`prd → spec`), in what wave order, and with what semantics for `spec`.

---

## Context

The vocabulary in arc-agents is split. Two competing terms are partly already in production:

- **`issue` (current)** — every ledger row. Table name (`issues`), CLI verb (`ledger issue <verb>`), JSON key (`r.issue`), `issue_events` companion table, `kind='issue'`.
- **`ticket` (target)** — already a verb in `~/.pi/skills/{to-tickets,implement,hard-merge,resolving-merge-conflicts,wayfinder}/SKILL.md`. The pi side has full ticket semantics (blocking edges, frontier work, expand-contract).

- **`prd` (current)** — the `kind=prd` row kind. PRD files at 7 repo roots (`agora/`, `arc-agents/`, `arc-factory/`, `onenation/`, `OneNation/` (case-variant, see below), `starlight-slm/`).
- **`spec` (target)** — already lives at `~/vault/missions-proposals/SPEC.md`, `webui-specs` mission subscriber, pi's `implement/SKILL.md` ("based on a spec or set of tickets").

The split is making the documentation harder to read across arc-skills + pi + arc-agents. The user's directive (2026-07-30): converge on `ticket` and `spec`.

The pi side already has well-formed semantics for both terms. arc-agents is the lagging party.

## Decision

**Decision 1: Rename waves.** Migrate in 4 ordered waves, each landing independently and gated on the previous:

1. **Wave 1 — prose.** `AGENTS.md`, `USER.md`, role files, NEW journal/inbox writes only. Historical analyses (forensic value) keep original term. ~50 hits.
2. **Wave 2 — skill + repo-root file renames.** `prd-to-issues` SKILL → `spec-to-tickets`; `PRD*.md` → `SPEC*.md` (7 files). Same risk class as Wave 1; bundled.
3. **Wave 3 — CLI surface.** `ledger ticket <verb>` becomes the canonical verb; `ledger issue <verb>` becomes a deprecated alias for one release; row JSON key `issue` becomes `ticket`; `issue_events` becomes `ticket_events`. Requires dual-write + dual-read window. ~280 hits across ~25 bin files.
4. **Wave 4 — schema.** `kind=spec` (replacing `kind=prd`); `tickets` table (replacing `issues`); drop the deprecated columns/table after Wave 3's deprecation window. Requires migration `bin/migrate-029.ts` + dual-write + dual-read window. ~140 hits.

**Decision 2: `spec` semantics — BROAD interpretation.** Adopt pi's broader `spec` shape rather than arc-agents' narrow `prd` shape. Specifically:

- `kind=spec` is the umbrella.
- `type` field discriminates: `type=prd` (objective + requirements + acceptance, the current prd shape), `type=design-doc` (the existing spec-template-draft shape), `type=ad-hoc` (in-prompt, ephemeral).
- This avoids Wave 3 collapsing on the "which kind of spec is this?" question and matches what pi already documents.

**Decision 3: `onenation` case-variant is OUT OF SCOPE.** The directory case-variant (`onenation/` vs `OneNation/`) is a separate concern and is NOT touched by this ADR.

## Migration status (2026-07-30)

- [x] **Wave 1 (prose)** — landed:
  - `~/repos/arc-skills/AGENTS.md` (symlink target of `/home/aaron/AGENTS.md`) — 2 edits (lines 76, 78)
  - `~/vault/USER.md` — 1 edit (line 36)
  - `~/vault/agents/director/objective.md` — 1 edit (line 28)
  - `~/vault/agents/interviewer/objective.md` — 3 edits (lines 16-18, 39, 45)
- [x] **Wave 2 (file renames)** — landed via `git -C <repo> mv` (working tree, uncommitted):
  - `~/repos/agora/PRD.md` → `SPEC.md`
  - `~/repos/arc-agents/PRD-arc-webui.md` → `SPEC-arc-webui.md`
  - `~/repos/arc-agents/PRD-v1.md` → `SPEC-v1.md`
  - `~/repos/arc-factory/PRD.md` → `SPEC.md`
  - `~/repos/onenation/PRD.md` → `SPEC.md`
  - `~/repos/OneNation/PRD.md` → `SPEC.md`
  - `~/repos/starlight-slm/PRD.md` → `SPEC.md`
  - `~/repos/arc-agents/skills/prd-to-issues/` → `spec-to-tickets/`
- [ ] **Wave 3 (CLI surface)** — PREPPED: `bin/migrate-029.ts` stub at `~/repos/arc-agents/bin/migrate-029.ts`. Wave 3 PR is filed separately (out of scope of this ADR).
- [ ] **Wave 4 (schema migration)** — gated on Wave 3 deprecation window.

## Alternatives considered

**Alt 1: Narrow `spec` (= current `prd` shape).** Cheaper rename, no schema change at the kind/type boundary. Rejected: defers the design-doc vs prd distinction to a future ADR, leaving the vocabulary still split.

**Alt 2: Big-bang single rename across all 4 waves.** Fast in calendar time, but every script, test, and webui page breaks simultaneously. Rejected: violates "MVP marked, hygiene at merge" — the merge would be large enough that no single human reviewer could clear it.

**Alt 3: Keep `issue`, only rename `prd → spec`.** Smaller surface, less breakage. Rejected: leaves the half-deployment problem unresolved; `pi/skills/to-tickets` continues to mean something different from `arc-agents/issues`.

**Alt 4: Rename to entirely new terms (e.g., `task` and `initiative`).** Clean slate. Rejected: ignores the fact that `ticket` and `spec` are already partly in use; introduces a third vocabulary instead of converging two.

## Consequences

### Positive
- Convergence onto terms that already have well-formed semantics in pi's skills.
- `kind=spec, type=prd` is more honest than `kind=prd` (which has been quietly overloaded with non-prd content).
- Wave-gating keeps each PR reviewable by a single human.
- Webui kanban reads from `ticket list --json` (no schema break for downstream consumers if Wave 3 ships deprecation aliases).

### Negative
- Wave 3 introduces 1 release of dual-verb pain (`ledger ticket` AND `ledger issue` both work). One PR per alias must NOT auto-merge.
- Wave 4 requires a SQLite migration.
- 7 `PRD*.md` files needed moves (completed 2026-07-30).
- The arc-agents skill renamed from `prd-to-issues` to `spec-to-tickets`; any caller that hard-codes the old path will need to update (grep target: `prd-to-issues` in `~/repos/arc-agents/`).

### Open
- Does the `kind=spec` umbrella encompass ALL existing `kind=prd` rows, or do some rows need explicit re-tagging? Triage during Wave 4.
- Should the deprecation alias period be 1 release or 1 quarter? Wave 3 PR review decides.

## Migration script

`~/repos/arc-agents/bin/migrate-029.ts` — STUB. Implements the renames declared above. Tests live in `bin/migrate-029.test.ts` (TBD during Wave 3 PR).

## References

- ADR-0012 — `~/repos/arc-agents/docs/adr/0012-director-agent-axi.md` (precedent: reframe arc-agents' scope without removing its responsibilities)
- `~/vault/agents/director/journal/director-2026-07-30-terms-migration-plan.md` (this ADR's wave plan)
- `~/vault/agents/director/journal/director-2026-07-30-terms-migration-execution.md` (Wave 1 + 2 execution log)
- `~/.pi/skills/to-tickets/SKILL.md` (target ticket semantics — already documented upstream)
- `~/.pi/skills/implement/SKILL.md` (target spec+ ticket pairing — already documented upstream)
