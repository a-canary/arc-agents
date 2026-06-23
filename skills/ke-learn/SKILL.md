---
name: ke-learn
description: "Write a new knowledge entry to ~/vault/ke/<scope>/ and update the FTS5 index. One file per insight. Stop-hook on dev/director sessions."
---

# ke-learn — Knowledge Entry Write

Append-only writer for `~/vault/ke/`. Auto-run by role profile `stop` hook to distill the session.

## When to write

- A non-obvious fix landed → `fixes/`.
- A design decision was made (with rationale) → `decisions/`.
- A failure mode was observed → `failures/`.
- A reusable concept clarified → `concepts/`.
- A factual constraint learned (tool version, API quirk) → `facts/`.

If the session produced nothing surprising, write nothing.

## File format

Path: `~/vault/ke/<scope>/<YYYY-MM-DD>-<kebab-slug>.md`

```
---
date: 2026-05-14
scope: fixes
tags: [ledger, sqlite, fts5]
source: session-<short-id>
---

# <one-line headline>

**Context:** what was happening.

**Insight:** the durable lesson.

**Refs:** commit shas, slice ids, file paths.
```

## Procedure

1. `bun ~/repos/ke/bin/ke-tool.ts learn --scope <scope> --title "<headline>" --body "<md>" [--tags "a,b"]` (or `ke learn …` if installed on PATH).
2. CLI writes file, then runs `INSERT INTO ke(path, body) VALUES(?, ?)` to update the FTS index at `~/vault/ke/_index/vec/ke.sqlite`.
3. Returns the new file path.

> **Runtime caveat — bun is currently broken for ke index ops.** `ke-tool.ts` depends on `better-sqlite3`, which bun does not yet support (bun issue #4290). `bun ke-tool.ts … compile|search|recall` fails with `'better-sqlite3' is not yet supported in Bun. In the meantime, you could try bun:sqlite which has a similar API.` Result: a `ke learn` under bun writes the note to disk but does NOT insert into the FTS index, so `ke recall` will miss it until reindexed.
> **Workaround:** run index-touching verbs under `npx tsx ~/repos/ke/bin/ke-tool.ts …` (node). The file write itself works under bun — only the index insert fails — but to be safe, run the whole command under node. After fixing, verify with `ke list <scope>` (filesystem scan) + `ke search <title-keyword>` (FTS); both should return the new note.

## Anti-patterns

- Don't write narrative session logs — those go to handoff, not KE.
- Don't write per-commit notes — git log is the source.
- Don't write "TODO" entries — KE is for what was learned, not what is pending.
- Don't duplicate — `ke-recall` first; if a close match exists, append refs to it instead.
