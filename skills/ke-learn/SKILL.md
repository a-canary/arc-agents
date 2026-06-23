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

## Anti-patterns

- Don't write narrative session logs — those go to handoff, not KE.
- Don't write per-commit notes — git log is the source.
- Don't write "TODO" entries — KE is for what was learned, not what is pending.
- Don't duplicate — `ke-recall` first; if a close match exists, append refs to it instead.
