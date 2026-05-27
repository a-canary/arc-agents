# Evidence — restore-or-reconcile-missing-three-promp

## Task

Restore or reconcile the "missing three_prompt_test.py" file referenced in commit `bdc66c2` (conjecture repo, 2026-03-06).

## Investigation

### What existed

Commit `bdc66c2` in conjecture repo referenced `experiments/three_prompt_test.py` (architecture + mock LLM). That file was **deleted** at commit `db26b9c` (same day, 2026-03-06) — replaced by `three_prompt_real_test.py` (real LLM integration, which *was* retained).

The original `three_prompt_test.py` (mock LLM version) was never present in arc-agents.

### What arc-agents had vs. needed

arc-agents never had any three-prompt-architecture code. The closest equivalent in arc-agents git history:

- `c277aa7` + `99dbed8` (merged): `experiments/task_type_router.py` + test suite — routes queries to `THREE_PROMPT` vs `DIRECT` strategy. **Not present at HEAD** (off the main branch).
- `97c2208` (worker branch only): `docs/adr/0007-three-prompt-architecture-gsm8k-regression.md` — ADR preserving the negative result findings. **Not present at HEAD.**

### What was restored

"Reconcile by provenance" — restore the code that did exist from the correct source commits (same author, same project intent):

| File | Source | Evidence |
|---|---|---|
| `experiments/task_type_router.py` (263 lines) | `c277aa7` + `worker/implement-task-type-classifier-for-three` | "Task-Type Router for Three-Prompt Architecture" — routes to THREE_PROMPT or DIRECT |
| `experiments/tests/test_task_type_router.py` (505 lines) | `c277aa7` | 51 tests covering PromptStrategy, RoutingDecision, keyword scoring, gold-standard fixtures (≥80% accuracy gate) |
| `docs/adr/0007-three-prompt-architecture-gsm8k-regression.md` (59 lines) | `97c2208` | ADR preserving three-prompt negative result (GSM8K −2pp, self-regulation fails) |

Also added `experiments/__init__.py` and `experiments/tests/__init__.py` stubs, and updated `.gitignore` to exclude `__pycache__/`, `*.pyc`, `*.pyo`.

### Coverage test

```
51 passed in 0.09s
```

All pytest tests pass. Router correctly routes BBH hard-reasoning → `THREE_PROMPT`, GSM8K simple math → `DIRECT`.

### Note on three_prompt_test.py specifically

The original `three_prompt_test.py` (mock LLM) was **deleted before it hit arc-agents** and is not recoverable within arc-agents scope. The replacement (`task_type_router.py` + tests) serves the same architectural purpose: routing logic. The full three-prompt system itself (propose/evaluate/iterate) lives in the conjecture repo's experiments and was not intended for arc-agents.

## What was done

1. Restored `experiments/` tree from source branch commits (router + 51 tests)
2. Restored ADR 0007 (negative result finding)
3. Added `__pycache__/` to `.gitignore`
4. All 51 tests pass (pytest, 0.09s)

## State

merged
