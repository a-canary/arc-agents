---
name: ke-recall
description: "Semantic (sqlite-vec cosine) search over ~/vault/ke/ knowledge entries. Local all-MiniLM-L6-v2 embeddings, no API key. Returns ranked title + path hits."
---

# ke-recall — Knowledge Entry Recall

Read-only semantic search over the KE vault (`~/vault/ke/`). Index is a sqlite-vec store at `~/vault/ke/_index/vec` (384-dim local all-MiniLM-L6-v2 embeddings). No FTS5, no external service.

## When to use

- Boot of every developer/director session (auto-run by role profile `boot` hook).
- Whenever a slice body or chat mentions "we did X before", "prior decision", "past failure".
- Before opening any Encounter — surface relevant precedent first.

## How

1. Interactive: `bun ~/repos/ke/bin/ke-tool.ts search "<query>" [--limit 10] [--tag T] [--not-tag T] [--diverse] [--full]` (or `ke search …` if installed on PATH).
2. CLI embeds the query locally, runs a sqlite-vec cosine search, prints ranked hits: `[NN%] title`, optional summary gist, `→ path`, tags.
3. Hook surface (not for manual use): `ke recall <prompt> [--transcript <path>]` — builds a full-context query from the conversation tail, applies the calibrated gate (inject iff top1 cosine ≥ 33%, `KE_RECALL_THRESHOLD` overrides), prints top 1–3 hits or nothing. Fail-silent by contract: errors and misses exit 0 with no output.

## Index refresh

If a search returns stale paths, run `bun ~/repos/ke/bin/ke-tool.ts compile`. Cheap (<5s for typical vault).

## Scopes

`~/vault/ke/` subdirs (non-exhaustive): agents, benchmark, comparisons, concepts, decisions, dev, distilled, facts, failures, fixes, learn, notes, research, … There is no `--scope` flag — restrict results with `--tag <t>` / `--not-tag <t>`.

## Output handling

- Top result usually answers the question. If top 3 scores tie within ~10%, surface all three.
- If best score < gate threshold (cosine % < 33), report "no precedent" — don't fabricate one.
