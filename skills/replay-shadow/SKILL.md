---
name: replay-shadow
description: "Capture a real execution of a worker-shaped system, replay it against a candidate config in an isolated sandbox, diff the two. Use before promoting prompt changes, model swaps, skill set changes, or API upgrades. System-agnostic — works for any unit of work that has identifiable inputs, environment state, an observable transcript, and a measurable output."
---

# replay-shadow — Capture-Replay-Diff for Confidence Before Promotion

A general dev practice for A/B-testing a candidate build against a live baseline *without* mirroring the full system. Pick one unit of work (a worker turn, a request, a job), freeze its execution, replay against the candidate, diff. Repeat across a corpus until variance stabilizes.

Replay-shadow is the unit-test analogue of live shadowing. Cheap, deterministic, runnable on every prompt change. Live shadow is the integration-test analogue — expensive, run before major cutovers. This skill is the cheap one.

## When to use

- Prompt iteration (system prompt, frame templates, skill set).
- Model swap (cost/quality tradeoff between two models for the same workload).
- API/SDK upgrade (does new client behave the same on real captured inputs?).
- Config change with non-obvious downstream effects (timeouts, retry policy, tool allowlist).

## When NOT to use

- Concurrency bugs, race conditions, factory backpressure — those need live load, not replay.
- UX integration regressions — those need the real transport.
- Anything where the input distribution itself is what changed.

Replay tests *behavior on past inputs*. It does not test the future.

## The three verbs

Three steps, three artifacts. The skill prescribes the contract; the agent wires it to the system at hand.

### 1. capture — freeze a real execution into a fixture

A **fixture** is the minimum reproducible context for one unit of work. Four parts:

| Part | What | Where to find it (varies by system) |
|---|---|---|
| **Input** | The exact stimulus the unit received | rendered prompt, HTTP request body, job payload, CLI args |
| **Env-snapshot** | The state the unit read against | git sha, DB snapshot, KE index snapshot, config file hash, env vars |
| **Transcript** | What the unit did, step by step | session JSONL, structured log, audit trail, strace, tcpdump |
| **Output-diff** | What the unit changed | ledger diff, DB diff, files written, commits, side-effecting API calls |

Capture procedure:

1. Pick a real, recently-executed unit. Prefer recent (state hasn't drifted far) and *representative* (covers a row in your input matrix).
2. Locate each of the four parts in your system's existing logs/state. If any part is missing, that's a gap in observability — fix it before continuing, because you can't replay what you can't see.
3. Serialize as `fixtures/<slug>.json` (or a directory if env-snapshot is heavy). Include enough metadata to identify the source unit (id, timestamp, system version).

Drift-tolerant snapshotting: for state that changes continuously (vector indexes, growing logs), snapshot at capture time and mount read-only at replay. Cost is bounded by fixture corpus size, not by elapsed time.

### 2. replay — run the candidate in an isolated sandbox

The **isolation contract** is the heart of the skill. Get this wrong and the shadow contaminates production.

1. **Scoped state.** Every state root the unit reads or writes is redirected to a sandbox copy. The candidate must not be able to reach live state even by accident. Use env vars, separate connection strings, separate filesystems — whatever the system supports.
2. **Mocked outbound surfaces.** Anything that produces a side effect visible outside the sandbox is mocked or no-op'd: external API calls, git pushes, message sends, emails, notifications. The mock records the *intent* (the call that would have happened) for diffing later.
3. **Frozen env.** Check out the captured git sha. Mount the captured state snapshots read-only. Inject the captured env vars. The candidate sees the world as it was at capture time.
4. **Replace only the thing under test.** If you're A/B-ing a prompt, swap the prompt; keep model, skills, tool surface identical. If you're A/B-ing a model, swap the model; keep prompt identical. One variable per replay run.
5. **Record everything.** Capture the candidate's transcript and output-diff in the same shape as the baseline fixture. Asymmetric serialization makes diffs unreadable.

If the sandbox can't be made airtight (the system has a side-effect surface you can't mock), document the leak and decide whether replay is still meaningful. Sometimes the answer is no — fall back to live shadow.

### 3. diff — structured comparison, scored

Compare baseline fixture vs candidate replay along three dimensions:

- **Transcript equivalence.** Same sequence of tool calls / commands / queries? Same files touched? Different paths that reach the same end-state are *interesting*, not necessarily wrong — flag them, don't auto-fail.
- **Output equivalence.** Same final state changes? Same rows written? Same children spawned? Same artifacts produced? Semantic equivalence beats string equivalence (a commit message can rewrite freely; a SQL row's primary key cannot).
- **Quality signals.** System-specific judgments: did the candidate fail when baseline succeeded? Did it ask for human input where baseline didn't? Did it produce more or fewer tokens, take longer, cost more? Did it terminate cleanly?

Emit a structured diff record per fixture: `{fixture_id, transcript_diff, output_diff, quality_deltas, score}`. Score is whatever the system warrants — pass/fail, numeric, or a vector. The point is repeatable comparison, not a single magic number.

## Corpus, not fixture

One replay tells you almost nothing. The signal is in the **distribution** of diffs across a representative corpus.

- Start at ~10 fixtures covering the obvious axes of variation in the input matrix.
- Replay the candidate against all of them. Look at the diff distribution.
- If results are noisy or inconclusive, grow the corpus until variance stabilizes (typically 30–100, depending on input diversity).
- Refresh fixtures periodically — old captures drift further from current input distribution. Stale fixtures test yesterday's system.

A passing single fixture is a smoke test. A passing corpus is a promotion gate.

## Judgment calls

**How much isolation is enough?** Enough that a candidate failure cannot corrupt live state and a candidate success cannot accidentally use live state to look better than it is. Less than that is unsafe; more than that is overhead.

**When is the baseline wrong?** Sometimes the candidate produces a *better* output than the captured baseline. The diff will flag this as a regression. Human review of flagged diffs is non-optional — auto-promote on score alone, and you'll lock in the baseline's mistakes.

**How to snapshot state that doesn't snapshot cleanly?** Append-only logs: capture a cursor, replay reads up to the cursor. Mutable state without versioning: rsync at capture, mount read-only. Truly un-snapshottable state (live external API): mock it and accept the leak in fidelity.

**When to throw out a fixture?** When the source unit was itself broken (baseline panicked, baseline got a wrong answer that's already known wrong, the captured env was misconfigured). Fixtures should represent the behavior you want to preserve, not the bugs you want to fix.

## Worked example — arc-agents worker turn

Illustrative. The pattern is what generalizes; the wiring is arc-specific.

**Unit of work:** one worker claim → execute → terminate cycle on a single task row.

**Capture:**
- *Input:* `bun ~/repos/arc/packages/arc-agents/bin/ledger.ts render-prompt <task-id> --worker <w>` — already exists, emits the exact system prompt the worker saw.
- *Env-snapshot:* repo + branch + HEAD sha at claim time (from `issue_events`); KE snapshot via `rsync ~/vault/ke ~/vault/replay-fixtures/<slug>/ke/`; task row + parent + thread history.
- *Transcript:* the worker's claude session JSONL at `~/.claude/projects/<proj>/<session>.jsonl`.
- *Output-diff:* ledger rows the worker wrote between claim and terminal state (`SELECT * FROM issue_events WHERE issue_id=? OR actor=?` plus children-spawned); commits + PR on the worktree branch; files committed.

Serialize as `~/vault/replay-fixtures/<task-slug>/{fixture.json, ke/, session.jsonl, ledger-diff.json}`.

**Replay:**
- Sandbox ledger: `ARC_LEDGER_DB=/tmp/replay-<slug>.db`, seeded with the captured parent + task row only.
- Sandbox KE: `KE_ROOT=~/vault/replay-fixtures/<slug>/ke`, mounted read-only.
- Sandbox worktree: `git worktree add /tmp/replay-<slug>-wt <captured-sha>`.
- Mocked bookie: a stand-in subagent that records intended writes to a scratch file instead of touching the sandbox ledger (or writes to it; either works, as long as the candidate's writes don't reach `~/vault/ledger.db`).
- Mocked git push, mocked HITL emission (record-only).
- Invoke claude with the captured rendered prompt, candidate config (e.g., new template version), candidate skill set.
- Capture the candidate's session JSONL + recorded writes.

**Diff:**
- Tool-call sequence: bash commands, file edits, subagent invocations — compare as ordered sequence with semantic tolerance (path rewrites, timestamp differences).
- Ledger writes: did the candidate reach the same terminal state? Decompose when baseline didn't? Emit HITL when baseline didn't?
- Quality: turn count, token cost, wall time, terminated-cleanly bool.

**Corpus:** seed with one fixture per (kind, type) combination in the ledger CHECK constraints — covers the worker matrix. Grow to ~30 with real captured tasks. Re-run on every change to `src/worker/templates.ts`, every bookie change, every model bump.

## Placement of the harness

The skill is system-agnostic; the harness is system-specific. For arc-agents, a `bin/arc-replay.ts` with `capture`/`replay`/`diff` verbs is the natural home. For another system, write its equivalent. The skill describes *what* to build; the binary is the *how* for that system.

Do not write a generic cross-system replay binary. The contract is shared; the wiring isn't. Generic replay harnesses become flag-soup that fits no system well.

## Anti-patterns

- **Mirror everything.** Don't try to shadow the whole system. Pick the smallest unit with a clean input/output boundary.
- **Replay without snapshotting state.** State drifts; "the same query against today's KE" is not a replay, it's a fresh run with old input.
- **Auto-promote on score.** Diffs need human eyes until you've calibrated what each kind of delta means for your system.
- **One fixture is enough.** It isn't. Build the corpus.
- **Skip the isolation contract.** A shadow that writes to live state is worse than no shadow — it produces false confidence and real damage simultaneously.
