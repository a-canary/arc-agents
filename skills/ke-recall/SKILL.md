---
name: ke-recall
description: "FTS5 search over ~/vault/ke/ knowledge entries. Returns top-N markdown excerpts ranked by BM25, with file paths and headings."
---

# ke-recall — Knowledge Entry Recall

Read-only search over the KE vault (`~/vault/ke/`). FTS5-indexed at `~/vault/ke.fts.db`.

## When to use

- Boot of every developer/director session (auto-run by role profile `boot` hook).
- Whenever a slice body or chat mentions "we did X before", "prior decision", "past failure".
- Before opening any Encounter — surface relevant precedent first.

## How

1. `bun ~/repos/ke/bin/ke-tool.ts recall "<query>" [--limit 5] [--scope decisions|failures|fixes|facts|concepts|*]` (or `ke recall …` if installed on PATH).
2. CLI runs `SELECT path, snippet(ke, …), bm25(ke) FROM ke WHERE ke MATCH ? ORDER BY bm25(ke) LIMIT ?`.
3. Output is JSON lines: `{path, score, excerpt, headings}`.

## Index refresh

If a recall returns stale paths, run `bun ~/repos/ke/bin/ke-tool.ts compile`. Cheap (<5s for typical vault).

> **Runtime caveat — bun is currently broken for ke index ops.** `ke-tool.ts` depends on `better-sqlite3`, which bun does not yet support (bun issue #4290). Under bun, `recall`/`search`/`compile` fail with `'better-sqlite3' is not yet supported in Bun. In the meantime, you could try bun:sqlite which has a similar API.` If you suspect a new note is missing from recall, first cross-check with `ke list <scope>` (filesystem scan, works under bun), then reindex under node: `npx tsx ~/repos/ke/bin/ke-tool.ts compile`. Never trust bun-side recall as a true negative until the index is rebuilt under node.

## Scopes

`~/vault/ke/` subdirs: agents, benchmark, comparisons, concepts, decisions, dev, distilled, facts, failures, fixes. Pass `--scope <name>` to restrict.

## Output handling

- Top result usually answers the question. If top 3 scores tie within ~10%, surface all three.
- If best score < threshold (BM25 > -2), report "no precedent" — don't fabricate one.
