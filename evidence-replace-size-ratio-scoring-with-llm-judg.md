# Evidence: replace-size-ratio-scoring-with-llm-judg

**Task:** Replace output-size-ratio scoring (crude heuristic) with LLM judge or structural depth metric

**Source commit:** not resolvable — `26ace67a` referenced in rubric commit does not exist in this repo. The task brief was reconstructed from:
- pipeliner `888cd6d` (feat: dynamic quality floor — 90% of best example score)
- pipeliner `.pi/pipelines/lib/qa-patterns.ts` (structural QA patterns)
- pipeliner `src/qa.ts` (QA class with LLM judge)
- pipeliner `src/models.ts` (ModelRegistry pass/fail only, no size ratio)
- pipeliner `src/llm-executor.ts` (Thompson sampling model selection)

**What the source code actually uses:**
- No output-size-ratio scoring found anywhere in pipeliner codebase
- `models.ts` records only **pass/fail** (no scores): `recordQA(model, task, passed)` with optional "costly" signal
- `qa.ts` uses **LLM judge** for semantic gates and structural rules for programmatic checks
- `catalog.ts` tracks example quality scores (0-10) for ranking, but no size ratio
- `benchmark-harness.ts` has statistical analysis but no size ratio

**Implementation delivered:**

`src/scorer/scorer.ts` — Quality scorer replacing the hypothetical size-ratio heuristic with:
1. **Structural scorer** (free, fast) — computes metrics: tokens, headings, code blocks, lists, tables, abstract/references/conclusion presence, avg line length, unique word ratio. Scores 0-10 based on breadth (multiple section types) + depth (abstract + references + conclusion) + substance (line length) + density (unique words). No size-ratio component.
2. **LLM judge** (optional, token cost) — invokes `pi --print` with semantic criteria, returns per-criterion scores + overall pass/fail.
3. **Composite scorer** — runs structural first; triggers judge if score < 5 or judge is configured.
4. **`scoreStructuredOutput()`** — for JSON outputs with required field validation.

`src/scorer/scorer.test.ts` — 17 tests covering metrics computation, scoring, structured output validation.

**Tests:** `bun test src/scorer/scorer.test.ts` — 17/17 pass

**Key design decisions:**
- Size is not quality — structural scorer does NOT use output/input size ratio
- LLM judge is opt-in (not forced); structural scorer always runs first
- Blocking triggers for score < 5 or tokens < 100 (escalation signal)

**Surprises (from diff-review):**
1. `26ace67a` source commit does not exist in this repo or its remotes — the task brief was reconstructed from pipeliner upstream
2. No existing size-ratio scoring was found to replace — the task created new infrastructure for what was described as a missing capability

**Gaps (from diff-review, acknowledged as follow-up):**
1. **No integration into pipeliner benchmark pipeline** — scorer exists in arc-agents but was not wired into `/home/aaron/repos/pipeliner/.pi/pipelines/` or the benchmark harness. Scope limited to arc-agents worktree; integration is a natural follow-up.
2. **LLM judge uses `execSync` to `pi --print`** rather than native pipeliner QA class (`src/qa.ts`) — external process exec rather than SDK integration. Acceptable as standalone module.
3. **Not added to `.pi/pipelines/lib/qa-patterns.js`** — the brief named that file specifically; scorer was created as new module in arc-agents instead.

**Diff-review findings (logged as kind=diff_review ledger event):**
- **Consequences:** scorer module added, no pipeline integration, no existing code removed, test suite expanded 17 cases.
- **ADR conflicts:** G-0008 (TypeScript default) — execSync shell call rather than native SDK integration. Not a hard conflict but noted.
- **Pre-existing test failures:** `ux-config.test.ts` and `ledger.test.ts` Zod errors are pre-existing, not introduced by this change.