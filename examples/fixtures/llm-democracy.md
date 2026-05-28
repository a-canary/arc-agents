---
title: LLM Democratization Strategy
summary: Papers and open-source making LLMs affordable, accessible, and vendor-lock-free.
tags: [llm, open-source, democratization, research]
updated: 2026-04-10
---

# LLM Democratization Strategy

**Context:** MS-003 goal — make LLMs affordable, accessible, autonomous, and vendor-lock-free.

**Insight:** Two leverage points: (1) local inference (Ollama, LM Studio reduce per-token cost to zero), (2) open-weight models (Qwen, Mistral) remove vendor dependency entirely.

**Approach:**
- Use local LLMs for all non-sensitive work via KE research loop
- Open-weight models for all inference — no OpenAI/Anthropic dependency
- Arc-agents uses MiniMax M2.7 for query synthesis only (cheapest viable option)

**Outcome:** KE warm-cache pattern achieves 29/30 technical reports at 55% lower evidence-phase cost vs fresh research.

**Refs:** `MS-003` in `~/vault/user.md`, `PRD-v1.md` §Empirical claim