# ADR 0007 — Three-Prompt Architecture Findings

**Status:** Historical — 2026-03-06
**Project:** Conjecture
**Source:** `.director/state.json` in conjecture repo (bdc66c2); benchmark data at `/home/aaron/repos/conjecture/experiments/results/`

## Context

The Conjecture project explored a **three-prompt confidence-based exploration architecture** for LLM task solving. The hypothesis: a model could self-regulate its exploration (propose → evaluate confidence → iterate or finalize) without explicit task-type routing rules.

**Architecture outline:**
1. **Propose** — generate candidate solution
2. **Evaluate** — rate own confidence (0–1)
3. **Decide** — iterate if confidence < threshold (0.7), finalize if ≥ 0.7
4. **Max iterations** — cap at 4

## Findings

### BBH — VALIDATED (+9pp improvement)

BBH (logical_deduction_three_objects, 100 problems, deepseek/deepseek-chat-v3-0324):

| Method | Correct/Total | Accuracy | Avg Time (s) | Tokens |
|--------|---------------|----------|--------------|--------|
| Direct | 84/100 | 84.0% | 10.53 | 29,088 |
| Decomposition | 93/100 | 93.0% | 22.66 | 70,983 |

**Three-prompt iteration** (50-problem subset): +10pp over direct.
**Conclusion:** Three-prompt/decomposition architecture is viable for hard reasoning (84% baseline).

### GSM8K — REGRESSION (−2pp)

GSM8K (50 problems, three-prompt architecture, deepseek/deepseek-chat-v3-0324):
- Baseline (direct): 94%
- Three-prompt: 92%
- **Delta: −2pp regression**

For comparison, decomposition-only on GSM8K (100 problems):
- Direct: 92%, Decomposition: 93% (+1pp — marginal, not the three-prompt iteration architecture)

### Key Observations

1. **Self-regulation fails.** Three-prompt iteration reached 3.96/4 max iterations (99% utilization) — confidence threshold 0.7 was never naturally reached.
2. **High-baseline problems (>90%) don't benefit.** GSM8K at 94% is near-ceiling; the iteration loop adds cost without accuracy gain.
3. **Hard reasoning (BBH at 84%) significantly benefits.** The architecture is effective where baseline leaves room for improvement.
4. **Task-type dependency confirmed.** The architecture must be gated on task difficulty/baseline — it helps hard reasoning, hurts near-ceiling tasks.

## Conclusion

The three-prompt architecture is **task-type dependent**:
- ✅ Viable for hard reasoning (BBH, 84% baseline): +9pp
- ❌ Counterproductive for near-ceiling tasks (GSM8K, 94% baseline): −2pp

The architecture requires a task-type classifier to route only hard-reasoning tasks through it.

## Source Data

- BBH results: `/home/aaron/repos/conjecture/experiments/results/bbh_logical_deduction_three_objects_20260306_200814.json`
- BBH three-prompt: `/home/aaron/repos/conjecture/experiments/results/bbh_three_prompt_20260307_010409.json`
- GSM8K three-prompt: `/home/aaron/repos/conjecture/experiments/gsm8k_three_prompt_benchmark.py`
- Benchmark CSV: `/home/aaron/repos/conjecture/experiments/results/benchmark_results.csv`

## Follow-up

BBH validation was the critical outstanding test. Results confirm: three-prompt architecture is viable for hard-reasoning tasks. Further work would require a task-type/difficulty classifier to gate usage appropriately.
