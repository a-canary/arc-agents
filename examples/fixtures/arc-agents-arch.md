---
title: arc-agents Architecture Overview
summary: SQLite ledger-based agent harness with ephemeral tmux workers and a bookie subagent.
tags: [arc-agents, architecture, agent-harness, ledger]
updated: 2026-05-01
---

# arc-agents Architecture Overview

**Context:** Need a transparent, observable agent harness that avoids headless subprocess traps.

**Insight:** Three components: ledger (SQLite message bus), factory (worker supervisor), bookie (ledger write authority). Every state change is an atomic SQL transition. Workers run as interactive tmux panes or headless pi with log + watchdog.

**Key decisions:**
- `M-0002`: ban on `claude -p` headless; `pi -p` headless is allowed with log+watchdog
- `G-0002`: single `UPDATE...RETURNING` for atomic claim
- `A-0004`: vault overrides repo

**Ledger schema:** `issues` + `issue_events`. State machine: ready → claimed → wip → review → merged.

**Refs:** `CLAUDE.md`, `CHOICES.md`, `docs/adr/`