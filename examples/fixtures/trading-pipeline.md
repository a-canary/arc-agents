---
title: Trading Pipeline Architecture
summary: Multi-stage pipeline: signal generation → risk check → order execution → position tracking.
tags: [trading, pipeline, finance]
updated: 2026-06-21
---

# Trading Pipeline Architecture

**Context:** Build a profitable personal trading system with real-time risk management.

**Insight:** Separation of signal generation (alpha), risk engine (guardrails), and execution (order router) as three independent stages. Each stage can be swapped without touching the others.

**Stages:**
1. Signal — generates candidate trades from market data
2. Risk — checks against portfolio limits, max drawdown, sector exposure
3. Execution — routes orders to broker, handles fills

**Key constraint:** Risk engine has veto power. Signal and execution cannot bypass it.

**Zero-order circuit-breaker:** The execution stage is monitored at the perimeter. If no orders are emitted within one trading cycle (or a configurable window), an alert fires immediately — before position drift or missed alpha accumulate. Zero-order is a silent-fail signature: the pipeline runs without errors but the execution feed is dark (data-feed drop, broker session expired, risk engine stuck). The circuit-breaker does not halt the pipeline; it escalates to the operator so the failure surface is visible.

**Refs:** `MS-001` in `~/vault/user.md`