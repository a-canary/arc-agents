---
title: Discord Bridge Architecture
summary: Bridge between ledger events and Discord channels for real-time agent notifications.
tags: [discord, bridge, notifications, arc-agents]
updated: 2026-03-15
---

# Discord Bridge Architecture

**Context:** Need to push ledger events to Discord in real-time without a polling loop.

**Insight:** The bridge uses a simple POST webhook per channel, with a routing table in `~/vault/agents/bridge-routes.json` that maps issue pool → Discord channel ID. Events are filtered server-side before push to avoid spam.

**Routes:**
- `pool=interactive` → `#agent-alerts`
- `state=failed` → `#alerts`
- `kind=prd` → `#planning`

**Refs:** `bin/arc-discord.ts`, `hooks/post-event.sh`