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

## Inputs expected on the row

The bookie-created row should include in `body_md`:

- **Target files** — explicit paths (e.g. `CONTEXT.md`, `docs/adr/0005-ledger-schema-prd-v1.md`).
- **Observation** — one sentence stating the drift, with line numbers if useful.
- **Suggested edit** (optional) — only if the answer is obvious; otherwise let the hygiene worker investigate.

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
