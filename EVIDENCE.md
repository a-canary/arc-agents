# Evidence: 85% Test Coverage Target Never Addressed

## Finding

The 85% test coverage target (I-0005 in Conjecture/CHOICES.md) was **never resolved** after commit `5b1ea43` (2026-03-03T05:00:22Z) which recorded 51.14% coverage.

## Current State

- **Conjecture coverage:** 53.96% (TOTAL: 9269 statements, 3942 covered, 2468 missing, 244 excluded)
- **I-0005 target:** 85%
- **Gap:** ~31pp

## History

| Date | Commit | Coverage | Notes |
|---|---|---|---|
| ~2026-02 | 7349db5 | 25% | Initial coverage push |
| ~2026-02 | 881be4f | 98% (layer) | smart_claim_selector only |
| 2026-02-20 | 0ead9ba | 50% (session end) | 824 tests |
| 2026-03-03 | 5b1ea43 | **51.14%** | Last known measurement; session BLOCKED |
| **today** | HEAD | **53.96%** | 1080 tests; only +2.8pp in ~3 months |

## Why Gap Persisted

1. The `.director/` state-tracking mechanism (which tracked this) was **removed from Conjecture** (no longer exists at HEAD)
2. No successor tracking mechanism created
3. Post-2026-03-03 commits (95 total) added test files but coverage barely moved (+2.8pp over ~3 months)
4. I-0005 still mandates 85% in CHOICES.md — no adjustment made

## Files with lowest coverage (drag on total)

- `src/cli/ui_enhancements.py`: 0.00%
- `src/evaluation/conjecture_lm.py`: 0.00%
- `src/config/dirty_flag_config.py`: 0.00%
- `src/process/self_verification.py`: 0.00%
- `src/cli/encoding_handler.py`: 23.33%
- `src/cli/claim_browser.py`: 42.32%
- `src/processing/llm/error_handling.py`: 42.92%

## Conclusion

**Gap is unaddressed.** I-0005 still mandates 85%; current coverage is 54%. The original `.director/` mechanism that tracked this is gone. This is not a regression — it was never closed. Recommend either:
- (a) Update I-0005 to a realistic target (e.g., 60%) with evidence
- (b) Spawn coverage push as a dedicated Conjecture task
- (c) Both — realistic interim target + concrete coverage task

## Evidence timestamp

2026-05-27 (current HEAD of Conjecture: a13bf45)