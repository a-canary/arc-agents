# Decision: Feedback Collector — Single No-Tools MiniMax Call, Degrade to 'General' on Failure

**Date:** 2026-07-11
**Status:** accepted
**Row:** `clarify-docs-feedback-aggregate-collecto`
**Source:** `bin/feedback-aggregate.ts` ponytail annotation (line 32)
**Observed in:** `000242-hygiene-arc-agents-ponytail-audit`

---

## TL;DR

The Collector tier (`collectCategories`) is a single no-tools MiniMax call that
groups a batch of feedback rows into thematic categories. On any failure (timeout,
unparseable JSON, model crash) it degrades to a single `"general"` category covering
all rows — the old batch-level behaviour — so no feedback batch is ever dropped.

## Design

```
collectCategories(project, rows):
  prompt = buildCollectorPrompt(project, rows)
  spawnSync("pi -p --no-tools --provider minimax --model MiniMax-M3 ...")
  if status==0 && stdout && parseCategoriesJson(stdout) yields valid categories:
    return those categories
  else:
    return [{ label: "general", pattern: "all feedback (collector unavailable)", ids: all_row_ids }]
```

Key properties:

1. **One call, no tools.** The collector gets a bare MiniMax model with no code
   execution, file system access, or search. This keeps the call cheap and fast
   — the collector runs every 5 minutes per project with queued feedback, so
   per-call latency matters.

2. **Words-only JSON output.** The prompt asks for a JSON object with no prose,
   no code fences. A code fence causes headless MiniMax to loop until timeout
   (same finding as `plan-agent.ts`'s `parsePlanJson` — ADR 0010). The parser
   (`parseCategoriesJson`) strips a fence defensively but the prompt explicitly
   forbids it.

3. **Degrade, don't drop.** If the MiniMax call fails (timeout, crash, unparseable
   output) the fallback `"general"` category still reaches the per-category
   confirmation gate (`confirmsProposal`). Unconfirmed categories never spawn a
   planner, so `"general"` with untrusted submitters just sits in the
   `feedback_theme` audit table as a no-op — the rows stay `new` for the next
   tick. No feedback is lost.

## Why not alternatives

- **Batch-level failure = drop nothing.** The old behaviour (before the Collector
  existed) treated the whole batch as one undifferentiated unit. The new Collector
  tries to split into thematic categories but the degrade path preserves the
  same safety guarantee: every row survives into the next scheduling tick.

- **Retry in the same tick** would add latency to the 5-minute schedule without
  improving correctness — the same rows just get a second try on the next tick.
  MiniMax timeouts are typically persistent (load or model degradation), not
  transient.

- **Fallback to a cheaper/smaller model** was considered but rejected because
  MiniMax-M3 is already the cheapest model in the pipeline. Adding a second
  provider creates credential/API-key complexity for a failure path that fires
  rarely.

- **Multi-call collector** (one MiniMax call per category) was rejected as
  over-engineering — the collector is a cheap grouping pass; the expensive
  call is the per-category planner spawn. A single call keeps the collector's
  budget ≈1% of the planner budget.

## Cross-references

- `bin/feedback-aggregate.ts` — `collectCategories()` (line ~200),
  `parseCategoriesJson()` (line ~170), `buildCollectorPrompt()` (line ~145)
- `plan-agent.ts` — same `parsePlanJson` shape and no-tools/no-fence pattern
  (ADR 0010 sources)
- `feedback_theme` table — CAM audit rows recording even unconfirmed categories
- `000242-hygiene-arc-agents-ponytail-audit` — the hygiene run that surfaced
  this as undocumented
