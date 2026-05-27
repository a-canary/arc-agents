# ADR 0007 — Three-Prompt Architecture GSM8K Regression Finding

**Status:** Historical (negative result) — 2026-03-06
**Project:** Conjecture
**Source commit:** `bdc66c2` (conjecture repo)

## Context

The Conjecture project explored a **three-prompt confidence-based exploration architecture** for LLM task solving. The hypothesis: a model could self-regulate its exploration (propose → evaluate confidence → iterate or finalize) without explicit task-type routing rules, solving the hard problem of knowing when to try harder.

**Architecture outline:**
1. **Propose** — generate candidate solution
2. **Evaluate** — rate own confidence (0-1)
3. **Decide** — iterate if confidence < threshold (0.7), finalize if ≥ 0.7
4. **Max iterations** — cap at 4

The architecture was validated on toy problems with 100% accuracy and 2-4 iterations. The critical test was GSM8K (a high-baseline math benchmark at ~94% accuracy for strong models).

## Decision (Negative Result)

The three-prompt architecture **regresses on GSM8K** — it makes things worse, not better.

| Benchmark | Baseline | Three-Prompt | Delta |
|---|---|---|---|
| Toy problems | N/A | 100% | ✅ Validated |
| GSM8K (50 samples) | 94% | 92% | **−2pp regression** |
| BBH (O-0008, 84% baseline) | +9pp with decomposition | not yet tested | pending |

### Key Findings

1. **Self-regulation fails.** Actual iterations: 3.96/4 (99% utilization). The model never naturally hit confidence ≥ 0.7 — it always iterated to the cap. The threshold was set too high.
2. **High-baseline problems (>90%) don't benefit.** GSM8K at 94% is already near ceiling. The "try harder" loop adds cost without accuracy gain.
3. **Token cost: 8.7x for −2pp.** The architecture burns 8.7× more tokens for a 2pp accuracy drop.
4. **Task-type dependency confirmed.** This aligns with O-0008 findings: the architecture works on hard reasoning tasks (BBH at 84% baseline) but not on already-strong baselines (GSM8K at 94%).

## Root Cause

The confidence threshold of 0.7 was never reached naturally by the model. The model was either overconfident (always below threshold, always iterating) or the threshold calibration was wrong for math tasks. Self-regulation as designed did not emerge.

## Unresolved / Follow-up

- **BBH critical test** was the recommended next step (not completed in this session). BBH at 84% baseline showed +9pp with decomposition in O-0008 — if three-prompt shows similar gains, the architecture is viable for hard reasoning. If not, abandon the architecture.
- **Lower threshold experiments** (0.5) and **reduced max iterations** (2-3) were suggested as iteration options.
- **Task-type routing** (O-0008 approach) remains the validated path for high-baseline tasks.

## Consequences for Conjecture

- The three-prompt architecture is **not a general-purpose improvement** — it must be gated on task type.
- Any future use of this architecture requires: (a) BBH validation, and (b) a task-type classifier to route only hard-reasoning tasks through it.
- The GSM8K regression is a genuine negative result — valuable because it prevents wasted effort scaling the architecture to tasks where it can't help.

## How to Verify

- Re-run GSM8K benchmark with the three-prompt system and confirm −2pp regression persists.
- Run BBH benchmark to determine if the regression is baseline-dependent.

## Source

Migrated from `.director/state.json` in conjecture repo (source commit `bdc66c2`, 2026-03-06). The state file was removed from the repo; this ADR preserves the findings durably at HEAD.
