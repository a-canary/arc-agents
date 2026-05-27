---
name: ke:prewarm
description: "Drain the research cascade queue during idle time. Triggers: idle, manual."
---

# /ke:prewarm — Cascade Queue Pre-warm

Drains the research cascade queue. Topics in the queue were flagged as gaps during prior research — prewarming them fills KB proactively.

## Usage

```bash
ke prewarm [max_items]
# default: 5 items
```

## When to run

- During idle time between tasks
- Before sessions on unfamiliar topics
- Daily via cron for continuous KB growth

## Cascade queue

Located at `~/vault/ke/research/evidence-cache/cascade-queue.md`. Each entry is a topic flagged as a gap. Prewarming converts them into indexed facts.

## Budget

~$0.50/day at 5 items/day. Each item uses ~500 tokens at cheap LLM pricing.

## Alternative

```bash
bun ~/repos/arc-agents/bin/ke.ts prewarm [max_items]
```
