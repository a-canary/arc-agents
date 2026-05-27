---
name: ke-recall
description: "Semantic search over the ~/vault/ke/ knowledge vault (Qdrant + MiniLM-L6-v2). Returns top-N notes ranked by cosine similarity, with scores, titles, and paths."
---

# ke-recall — Knowledge Entry Recall

Read-only semantic search over the KE vault (`~/vault/ke/`), backed by the Qdrant collection `ke`.

## When to use

- Boot of every developer/director/admin session (auto-run by role profile `boot_skills`).
- Whenever a slice body or chat mentions "we did X before", "prior decision", "past failure".
- Before opening any Encounter — surface relevant precedent first.

## How

```
bun ~/repos/ke/bin/ke-tool.ts search "<query>"
```

- Ranks all notes by cosine similarity (scores shown as a percentage).
- Each hit prints: `[score%] Title`, summary, `→ path`, and tags.
- For a Claude-synthesised answer instead of raw hits, use `query` instead of `search`:
  `bun ~/repos/ke/bin/ke-tool.ts query "<question>"`.

## Index refresh

If search returns stale or missing results, re-index:
```
bun ~/repos/ke/bin/ke-tool.ts compile
```

## Topic filtering

`~/vault/ke/` subdirs include: agents, benchmark, comparisons, concepts, decisions, dev, distilled, facts, failures, fixes, infrastructure, patterns, projects, references, research. To restrict by topic/tag, use `select`:
```
bun ~/repos/ke/bin/ke-tool.ts select --topic <topic> --tag <tag>
```

## Output handling

- Top result usually answers the question. If the top few scores tie within ~10%, surface all of them.
- If the best score is low (under ~40%), report "no strong precedent" — don't fabricate one.