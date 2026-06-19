---
name: clarify-docs
description: "Hygiene phase skill. Fix doc/code drift, broken refs, stale ADRs, missing glossary terms, failed example commands. Docs-only PR, ≤3 files, ≤100 lines diff. Run via bookie create --kind task --class hygiene --title 'clarify-docs: <observation>'."
---

# clarify-docs — Hygiene-Phase Documentation Fix

When a worker notices drift between code and docs during its primary slice, the temptation is to fix it inline. Resist. A doc fix bundled into a code slice violates G-0005 (one slice per worktree per commit) and obscures the audit trail. Instead, emit a `class=hygiene` followup row pointing at this skill.

## When to use

- Glossary term referenced in code but missing from CONTEXT.md (or vice versa).
- CHOICES.md decision id (`G-0007`, `I-0006`, etc.) cited in code/comments but no matching row in CHOICES.md, or row text contradicts current behavior.
- ADR claims behavior that the code no longer matches.
- Broken file/path/skill-name reference in any markdown doc.
- Example command in README/CLAUDE.md/skill doc fails when run literally.
- Two docs (CONTEXT.md and a contexts/<bc>/CONTEXT.md, or an ADR and CHOICES.md) disagree on the same fact.
- The commit-review rubric is missing a disposition clause, producing unresolvable tasks that waste worker cycles.

## Inputs expected on the row

The bookie-created row should include in `body_md`:

- **Target files** — explicit paths (e.g. `CONTEXT.md`, `docs/adr/0005-ledger-schema-prd-v1.md`).
- **Observation** — one sentence stating the drift, with line numbers if useful.
- **Suggested edit** (optional) — only if the answer is obvious; otherwise let the hygiene worker investigate.

## MISSING_AT_HEAD Rubric Gap (specific pattern)

The commit-review rubric (embedded in `source_module=commit-review` task body_md) has a gap: when both the **source commit** AND the **referenced file** are `MISSING_AT_HEAD` and `still_relevant: 0/3`, the task is provably unresolvable — no investigation can recover the artifact. The rubric must include this early-exit clause:

```
still_relevant: 0/3 AND source commit MISSING_AT_HEAD AND referenced file MISSING_AT_HEAD
  → CANCELLED (unresolvable — target commit and artifact both absent)
```

The current rubric only covers the case where the referenced file is `MISSING_AT_HEAD`, directing workers to "clarify whether the pattern should be re-instantiated." This is valid only when the source commit IS accessible. If the source commit is also `MISSING_AT_HEAD`, no amount of code investigation can resolve the task — it must exit CANCELLED immediately to avoid wasted worker cycles.

**Evidence**: Task `determine-disposition-of-deferred-26ace6` spent a full worker cycle investigating only to find source commit `26ace67a` absent from every accessible repo and the referenced journal file `agents/admin/journal/2026-04-17.md` absent from HEAD. The work was provably unresolvable from the start.

### How to fix the rubric

When updating a `source_module=commit-review` task body_md, extend the rubric with the missing clause:

```markdown
**Rubric:**
- still_relevant: 0/3
- intent_achieved: 3/3
- regression_risk: 3/3
- followup_needed: 1/3
- staleness: 1/3

**Recommended action:**
<!-- EXISTING: referenced file MISSING_AT_HEAD only -->
The journal file (agents/admin/journal/2026-04-17.md) this commit targets is MISSING_AT_HEAD, suggesting the journal system was removed. The commit itself states '26ace67a analysis now requires manual distillation or retry,' indicating a named deferred task. If the journal system is gone, this entry is purely historical; if it was moved, the deferred analysis needs to be re-created in the new location. Clarify whether the cascade/distillation journal pattern should be re-instantiated or the gap closed explicitly.

<!-- ADD THIS CLAUSE -->
**Unresolvable early exit (added per clarify-docs):**
If the source commit itself is MISSING_AT_HEAD (verified via `git cat-file -t <sha>` in every accessible repo) AND the referenced file is also MISSING_AT_HEAD AND still_relevant is 0/3:
→ CANCELLED immediately (unresolvable — target commit and artifact both absent; no investigation can recover the artifact). No further code investigation needed.
```

The canonical check for source commit existence:
```bash
git cat-file -t <sha>   # returns type or "fatal: not a valid object name"
```
If the SHA is unknown in every accessible repo, immediately CANCEL with evidence_md documenting the failed checks.

## Deliverable shape

- Docs-only PR. **No** code changes, no test changes. If the fix requires code, the row is mis-classified — bookie should `update --state cancelled` and the original worker should emit a `class=quality` or `class=mvp` row instead.
- Touch ≤3 files. Larger sweeps decompose into multiple hygiene rows.
- ≤100 lines net diff.

## Slice budget

≤30 minutes wall-clock, ≤100 lines diff. If the investigation balloons past that, stop and `update --state failed --evidence "scope larger than clarify-docs budget; needs decomposition"`. Do not silently expand the slice.

## Verification

Before merge:

- `bun run typecheck` — even though we touched no code, importers of any moved/renamed reference must still resolve.
- `git grep -nF "<CHOICE-id-or-term>"` — confirm every remaining reference is consistent with the new doc text.
- If an example command was edited, run it.

## Termination

Drive to `merged` via bookie with `--evidence "doc/code drift fixed in <files>"` and `--pr <branch-or-url>`. If the observation turned out to be a false alarm (no actual drift), `update --state cancelled --evidence "no drift found; closing"`.
