---
name: replay-shadow
description: "Capture a real execution of a worker-shaped system, replay it against a candidate config in an isolated sandbox, diff the two. Use before promoting prompt changes, model swaps, skill set changes, or API upgrades. System-agnostic — works for any unit of work that has identifiable inputs, environment state, an observable transcript, and a measurable output."
---

# replay-shadow — Capture-Replay-Diff for Confidence Before Promotion

A/B-test a candidate build against a live baseline *without* mirroring the full system. Pick one unit of work (a worker turn, a request, a job), freeze its execution, replay against the candidate, diff. Repeat across a corpus until variance stabilizes.

Replay-shadow is the unit-test analogue of live shadowing: cheap, deterministic, runnable on every prompt change. Live shadow is the integration-test analogue — expensive, run before major cutovers.

## When to use

- Prompt iteration (system prompt, frame templates, skill set).
- Model swap (cost/quality tradeoff for the same workload).
- API/SDK upgrade.
- Config change with non-obvious downstream effects (timeouts, retries, tool allowlist).

## When NOT to use

- Concurrency bugs, race conditions, backpressure — need live load.
- UX integration regressions — need the real transport.
- Anything where the input distribution itself is what changed.

Replay tests *behavior on past inputs*. It does not test the future.

## The three verbs

### 1. capture — freeze a real execution into a fixture

A **fixture** is the minimum reproducible context for one unit of work. Four parts:

| Part | What | Where to find it (varies by system) |
|---|---|---|
| **Input** | Exact stimulus the unit received | rendered prompt, request body, job payload, CLI args |
| **Env-snapshot** | State the unit read against | git sha, DB snapshot, index snapshot, config hash, env vars |
| **Transcript** | What the unit did, step by step | session JSONL, structured log, audit trail |
| **Output-diff** | What the unit changed | ledger diff, DB diff, files written, side-effecting API calls |

Pick a recent, representative unit. Locate each part in your system's existing logs/state — if any part is missing, that's an observability gap; fix it before continuing. Serialize as `fixtures/<slug>.json` (or a directory if env-snapshot is heavy) with metadata identifying the source (id, timestamp, version).

Drift-tolerant snapshotting: for continuously-changing state (vector indexes, growing logs), snapshot at capture and mount read-only at replay.

### 2. replay — run the candidate in an isolated sandbox

The **isolation contract** is the heart of the skill. Get this wrong and the shadow contaminates production.

1. **Scoped state.** Every state root the unit reads or writes redirects to a sandbox copy. Use env vars, separate connection strings, separate filesystems.
2. **Mocked outbound surfaces.** External API calls, git pushes, message sends, emails: mocked or no-op'd. The mock records *intent* for diffing.
3. **Frozen env.** Check out the captured git sha. Mount captured snapshots read-only. Inject captured env vars.
4. **Replace only the thing under test.** One variable per replay run.
5. **Record everything** in the same shape as the baseline. Asymmetric serialization makes diffs unreadable.

If the sandbox can't be made airtight, document the leak and decide whether replay is still meaningful — sometimes the answer is no and you fall back to live shadow.

### 3. diff — structured comparison, scored

Compare baseline vs candidate along three dimensions:

- **Transcript equivalence.** Same sequence of tool calls / commands / queries? Different paths that reach the same end-state are *interesting*, not necessarily wrong — flag, don't auto-fail.
- **Output equivalence.** Same final state changes? Same artifacts? Semantic equivalence beats string equivalence.
- **Quality signals.** Did the candidate fail when baseline succeeded? Ask for human input where baseline didn't? More/fewer tokens, longer, costlier? Terminate cleanly?

Emit `{fixture_id, transcript_diff, output_diff, quality_deltas, score}`. The point is repeatable comparison, not a single magic number.

## Corpus, not fixture

One replay tells you almost nothing. The signal is in the **distribution** of diffs across a representative corpus.

- Start at ~10 fixtures covering obvious axes of variation.
- Grow until variance stabilizes (typically 30–100).
- Refresh periodically — stale fixtures test yesterday's system.

A passing single fixture is a smoke test. A passing corpus is a promotion gate.

## Judgment calls

- **When the baseline is wrong.** Sometimes the candidate produces a *better* output and the diff flags it as regression. Human review of flagged diffs is non-optional.
- **Un-snapshottable state.** Append-only logs: capture a cursor. Mutable unversioned: rsync at capture, mount read-only. Live external API: mock and accept fidelity loss.
- **Throw out a fixture** when the source unit was itself broken — fixtures represent behavior to preserve, not bugs to fix.

## Placement of the harness

The skill is system-agnostic; the harness is system-specific. For arc-agents, a `bin/arc-replay.ts` with `capture`/`replay`/`diff` verbs is the natural home. Don't write a generic cross-system replay binary — generic harnesses become flag-soup that fits no system well.

## Anti-patterns

- **Mirror everything.** Pick the smallest unit with a clean input/output boundary.
- **Replay without snapshotting state.** "Same query against today's index" is not a replay, it's a fresh run with old input.
- **Auto-promote on score.** Diffs need human eyes until each kind of delta is calibrated.
- **Skip the isolation contract.** A shadow that writes to live state is worse than no shadow.
