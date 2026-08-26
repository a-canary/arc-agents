# Champion/Challenger — ndivisible director model (opus → qwen3.8)

Pre-registered gate for any swap of the ndivisible director cron model.
Written before adjudication. Do not edit thresholds after seeing challenger data;
amend only via a new dated section below.

Ledger row: `champion-challenger-ndivisible-director-` (arc-agents).
Date pre-registered: 2026-08-26T20:30Z.

## Setup

- **Champion:** `claude --model opus -p "/director /home/aaron/projects/ndivisible --afk"` every 6h (crontab line 1). Claude Code 2.1.x, OAuth billing.
- **Challenger:** qwen3.8-27B (`unsloth/Qwen3.8-27B-GGUF` on the Veles V100 box, Q4_K_M, ~24 tok/s decode). $0 API cost; shared GPU box — cooperative lease rules apply.
- **Workload:** `/director --afk` tick against `/home/aaron/projects/ndivisible` (gap analysis → dispatch decisions → .arc events + NEXT.md + git).
- **Substrate:** ndivisible does NOT use the arc-agents SQLite ledger. Quality evidence lives in `.arc/events.jsonl`, `NEXT.md`, `.arc/director/{gaps,inflight,blocked}.md`, and git history. The row body's "ledger row completion" metric maps to `task.completed`/`qa.passed` events on this substrate.

## Champion state at pre-registration (evidence)

- **Champion cron is dead.** Every tick since ~2026-08-12 fails in `~/vault/ndivisible/director-cron.log`:
  - 2026-08-12..13: `403 This token has no access to model anthropic/claude-opus-5`
  - 2026-08-13..16: `403 remaining credit limit: ＄-0.031714 ... insufficient balance`
  - 2026-08-16..26 (ongoing): `Not logged in · Please run /login`
- Last successful opus tick: ~2026-08-11 (log line ~2980). Quality sample of that tick: gap analysis with two explicit human-gate items (Turnstile widget config; FK band re-shape decision), clear recommendation, `State: idle`.
- Champion baseline from `.arc/events.jsonl` (full span 2025-07-03 → 2026-07-28; log dormant after 2026-07-28 — caveat):
  - QA pass rate: 34 passed / 4 failed = **89.5%** (rework proxy)
  - `task.completed` 47, `task.assigned` 18, `task.blocked` 1
  - Human-gate escalations: `director.blocked` 14 vs `director.idle` 29 (~33% of terminal ticks blocked-on-human)
  - Gaps: 8 found / 3 closed / 1 parked
  - Incidents: 2 detected / 2 resolved (rootcause recorded for at least one)
- Throughput proxy (git commits/day, Jul–Aug 2026): peak 5–17/day mid-Jul → early Aug; 1–3/day after cron death.

## Gate (pre-registered)

Primary metric: **QA pass rate** = `qa.passed / (qa.passed + qa.failed)` over challenger ticks, measured on the ndivisible substrate.

Secondary metrics:
1. Tick completion rate — fraction of 6h ticks that finish a full director loop (state line emitted, no crash/timeout).
2. Tool-calling reliability — harness-bench `core` suite pass rate + malformed-tool-call count (second data point; see below).
3. Block ratio — `director.blocked / (director.blocked + director.idle)`; challenger must not escalate humans more than champion (champion ≈ 0.33).

Sample size: **n = 20 challenger ticks** (~5 days at 6h cadence) before adjudication. No promotion on less.

Interim kill criteria (stop the A/B early, keep champion):
- 10 consecutive ticks fail to complete a full loop, or
- ≥3 safety incidents (erroneous writes to prod state, data loss, unreviewed deploys), or
- block ratio > 0.6 in any rolling 10-tick window.

Promotion rule (all must hold):
- QA pass rate ≥ champion baseline − 5pp (i.e. ≥ 84.5%), and
- tick completion ≥ 90% over the 20-tick window, and
- zero safety incidents, and
- judge (LLM-judge or human) rates challenger ≥ champion on ≥ 70% of pairwise tick comparisons against the champion quality sample above.

Rollback: revert the one crontab line (<1 min). Reversible by design — blast radius is one project's autonomous cadence.

## Second data point — harness-bench core, qwen3.8 (running at pre-registration)

- Run: `bin/bench run core --model unsloth/Qwen3.8-27B-GGUF --label cc-qwen38-core-20260825` in `~/repos/harness-bench`, pi harness, 68 tasks.
- Interpretation: pass rate = tool-calling reliability proxy for the qa-journey pattern (qa-journey itself went deterministic on 2026-07-07 and no longer uses an LLM; this measures whether qwen3.8 could have done that job).
- Result (2026-08-26T21:24Z): **59/68 pass = 86.8%**, quality score 86.8, run `202608262018199-20a7ff`, harness=pi, model `unsloth/Qwen3.8-27B-GGUF` (Q4_K_M on Veles V100).
  - Failures (4): codegen-cli-tool, codegen-rest-api, file-operations-heterogeneous-dates, quixbugs-python-subsequences.
  - Timeouts (5): debugging-logistic-regression-divergence (360s cap), games-mahjong-winning-hand (360s cap), hard-implement-trie (240s), quixbugs-python-bitcount (180s), quixbugs-python-minimum_spanning_tree (180s).
  - Caveat: no opus/champion baseline exists in harness-bench history (all prior runs are local models: Bonsai, Qwen variants, MiniMax-M3). This is a standalone reliability data point for qwen3.8, not a pairwise A/B. Pattern of misses: two long-horizon debugging/planning tasks and two codegen tasks; quixbugs batch (short fix-a-bug tasks) 37/40.
  - Read-through to gate secondary metric 2: tool-calling reliability is strong on short task loops, weak under long-horizon planning. Director ticks are mid-horizon; the 20-tick A/B remains the deciding measurement.

## Adjudication log

(amend-only-below; each entry dated, no threshold edits above this line)

- **2026-08-26T21:30Z** — Pre-registration complete; second data point (harness-bench core) recorded above. A/B tick loop NOT yet started: champion cron is dead (evidence above), so "champion vs challenger" in production is actually "dead opus vs qwen3.8". Two execution modes are open and the fork is taste/impact (autonomous writes to a live project for ~5 days) plus write-lane (crontab edits require operator approval):
  - **Mode A (prod swap):** replace crontab line 98 with a qwen3.8-backed director tick; challenger runs the real workload; kill criteria + rollback (<1 min) as pre-registered. Data validity: highest.
  - **Mode B (shadow):** worktree of ndivisible under operator-approved path; scheduled qwen3.8 ticks against the shadow copy; zero blast radius on live state; data weaker (stale gap set, no real event wake).
  - Decomposed to HITL child for mode selection + crontab approval; runner child blocked on it. No threshold edits made.
