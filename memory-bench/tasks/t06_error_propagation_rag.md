# Task T06: Error Propagation Analysis in Multi-Agent Pipelines

**Category:** Systems thinking / Reliability engineering
**Difficulty:** Hard
**Expected tokens:** ~10,000–20,000 input + ~3,000–5,500 output

## Problem Statement

> "Design a failure taxonomy for a production RAG system where: (1) a reranker agent scores retrieved chunks, (2) a router agent decides whether to use web search fallback, (3) a synthesis agent produces the final answer. The system serves 10M queries/day with a 99.9% uptime SLA. Identify every failure mode at each stage, propagate the failure probability through the pipeline, and specify the minimum viable redundancy strategy to achieve the SLA. Then design a synthetic benchmark that would expose the 3 most dangerous hidden failure modes before they reach production."

## Requirements

1. Build a complete failure taxonomy for all 3 stages (at least 8 distinct failure modes)
2. For each failure mode: probability estimate, detection method, containment strategy
3. Propagate cumulative failure probability through the full pipeline
4. Specify the minimum viable redundancy strategy (what duplicate stages, what fallbacks)
5. Design a synthetic benchmark suite that would expose the 3 most dangerous hidden failure modes:
   - Describe the synthetic data generator for each
   - State why natural distribution testing would miss these
   - Specify the pass/fail criteria for each benchmark
6. End with the single most important architectural decision that would reduce failure surface area the most

## Quality Bar

- Math is not required but probability estimates must be grounded in realistic assumptions
- Failure modes must be specific (not "model hallucination" — specify mechanism)
- Benchmark must be implementable with today's tools (no sci-fi requirements)
- 600–1000 words
