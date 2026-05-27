---
name: ke-learn
description: "Write a new knowledge entry into ~/vault/ke/<scope>/ and embed it into the Qdrant index via ke-tool ingest. One file per insight. Stop-skill on dev/director/admin sessions."
---

# ke-learn — Knowledge Entry Write

Writer for `~/vault/ke/`, backed by the Qdrant collection `ke`. Auto-run by role profile `stop_skills` to distill the session.

## When to write

- A non-obvious fix landed → `fixes/`.
- A design decision was made (with rationale) → `decisions/`.
- A failure mode was observed → `failures/`.
- A reusable concept clarified → `concepts/`.
- A factual constraint learned (tool version, API quirk) → `facts/`.

If the session produced nothing surprising, write nothing.

## File format

Write the note with this frontmatter (`ke ingest` reads `title`, `tags`, `summary`):

```
---
title: <one-line headline>
tags: [ledger, sqlite, qdrant]
summary: <one-sentence gist — used as the search-result blurb>
created: 2026-05-24
---

# <one-line headline>

**Context:** what was happening.

**Insight:** the durable lesson.

**Refs:** commit shas, slice ids, file paths.
```

## Procedure

1. Write the note to a temp file (e.g. `/tmp/ke-learn-<slug>.md`) with the frontmatter above.
2. Ingest it — this moves it into `~/vault/ke/<scope>/`, embeds it, and upserts to Qdrant:
   ```
   bun ~/repos/ke/bin/ke-tool.ts ingest /tmp/ke-learn-<slug>.md --topic <scope>
   ```
3. The CLI prints the final `Written: <scope>/<slug>.md` path. Omit `--topic` to let it auto-classify from content.

Requires Qdrant on `:6333` (`docker run -d --name qdrant -p 6333:6333 qdrant/qdrant`). If ingest reports a connection error, start it and retry.

## Anti-patterns

- Don't write narrative session logs — those go to handoff, not KE.
- Don't write per-commit notes — git log is the source.
- Don't write "TODO" entries — KE is for what was learned, not what is pending.
- Don't duplicate — run `ke-recall` first; if a close match exists, append refs to it and re-ingest instead of creating a new note.