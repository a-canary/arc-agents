---
name: ke-learn
description: "Write a new atomic-claim note via `ke learn` into ~/vault/ke/topics/ and index it in the sqlite-vec store. One note per insight. Stop-hook on dev/director sessions."
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

The CLI writes the note itself — you supply raw material, not a rendered file.

Path: `~/vault/ke/topics/<slug>.md` (slug derived from the distilled summary).

```
---
title: "<summary, first 80 chars>"
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
tags: ["ke-generated", "ke-learn"]
sources: ["<source-label>"]
src: "learn"
parent_topic: "<topic or empty>"
---

# <summary>

- [high|medium|low] <atomic claim> [src:<label>]( <ref>)?
```

Each fact is one atomic-claim line; the `( ref)` suffix appears only when the
resource was a file or URL.

## Procedure

1. `bun ~/repos/ke/bin/ke-tool.ts learn "<fact or text>" [--topic <topic>]` (or `ke learn …` if installed on PATH). The resource may also be `@path/to/file.md` or an http(s) URL — fetched once.
2. CLI runs LLM distill over the material, atomizes it into atomic claims, writes the note to `~/vault/ke/topics/<slug>.md`, then embeds + upserts it in the sqlite-vec store so it is immediately searchable via ke-recall.
3. Prints `Written: <relPath>` and `Indexed: <relPath>` on success.

## Anti-patterns

- Don't write narrative session logs — those go to handoff, not KE.
- Don't write per-commit notes — git log is the source.
- Don't write "TODO" entries — KE is for what was learned, not what is pending.
- Don't duplicate — `ke-recall` first; if a close match exists, append refs to it instead.
