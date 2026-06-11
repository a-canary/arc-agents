# Evidence — i-benchmark-config-coverage-audit-wpki

**Worker:** arc-worker-a-ot2fas
**Date:** 2026-06-11
**Worktree:** /home/aaron/worktrees/arc-agents-i-benchmark-config-coverage-audit-wpki
**Branch:** worker/i-benchmark-config-coverage-audit-wpki

## Verdict

The original PRD `i-benchmark-config-coverage-audit-wpki` cannot be executed as a
single slice. The work decomposes into **1 HITL decision + 3 build slices**.
Decomposing now and freeing the claim for the factory.

## Verification commands run this session

```
$ ls /home/aaron/benchmark/memory-bench/
optimize-no-ledge/

$ find /home/aaron -maxdepth 7 -name 'harness*.py' 2>/dev/null
(no results)

$ ls /home/aaron/benchmark/memory-bench/optimize-no-ledge/runs/ea_g1_r1_4c95aed4_rep1/
track_a/session_1/working/config    # empty; not a memory-bench harness
```

## Disk findings

| Path | What it is | Memory-bench relevant? |
|---|---|---|
| `/home/aaron/benchmark/hermes-memory-bench/` | 2-config working harness (baseline + echo) over 6 task YAMLs (t01–t06) | Structural model only |
| `/home/aaron/benchmark/hermes-memory-bench/scripts/run_benchmark.py` | Orchestrator (tmux + hermes chat, OR echo) | Usable template |
| `/home/aaron/benchmark/hermes-memory-bench/scripts/analyze_and_report.py` | LLM-judge + Elo + Markdown report | Usable template |
| `/home/aaron/benchmark/memory-bench/` | Empty scaffold (`optimize-no-ledge/runs/` is from a different benchmark) | Target tree absent |
| `/home/aaron/sandbox/memory-bench/` | 20 empty `memory-bench-nl-evo-*` worktree dirs | Empty scratch |
| `/home/aaron/.hermes/profiles/memory-bench-*` | 10 hermes profiles: builtin, flowstate, hermes, holographic, ke, mem0, noledge, obsidian, plur, wiki | The real config surface |
| `~/vault/webui/techtree/encounters.json` | E-043 "memory-bench task set: standardize or diversify?" status=decided but NOT applied | Dormant decision |
| `~/vault/agents/director/inbox/20260512T175029Z-595043f3.md.done` | Original E-043 inbox note | Source of pending decision |
| RD-09 referenced by PRD | Not present anywhere on disk | Stale reference |

## Mismatch with PRD claims

| PRD claim | Reality |
|---|---|
| 8 configs × 5 tasks × 3 reps = 120 runs | Source list of 8 configs not on disk; hermes profile list has 10 names |
| audit_coverage.py committed to memory-bench/ | Not present; tree absent |
| harness.py / harness_multi.py exist | Not present; tree absent |
| statistics/summary.json, elo/rankings.json exist | Not present |
| RD-09 GAP analysis | Not found on disk |

## E-043 (the dormant decision)

Title: "memory-bench task set: standardize or diversify?"
Options:
- A) Standardize all configs on 7 complex tasks (drop 6 micro-tasks). Clean Elo.
- B) Keep all 9 tasks across all configs (add 2 missing YAMLs). Richer signal.
- X1) Two tiers: 7 complex for Elo, optional 13-task extended suite.
- X2) Re-run plur first to confirm 5-rep gap is incomplete-run vs design.
- X3) Treat SPEC.md as descriptive; update to match 9-task reality.

Status field is "decided" in the encounter JSON but no option was actually
applied — SPEC.md, task YAMLs, and harness all retain the 5/6/7/9/13 confusion.

## Decomposition

Per doctrine §2 ("Concern → HITL Decomposition"), the parent task is too broad
for one slice. The 8-config × 5-task × 3-rep matrix presupposes a harness, a
canonical task set, and a config roster — all of which need either human
decision or build work. Fanout cap = 5; I file 4 children (1 HITL, 3 mvp).

Children to be created under `i-benchmark-config-coverage-audit-wpki`:

1. **`hitl-benchmark-spec-task-set-and-configs`** *(HITL)* — Human decision
   needed on: (a) canonical task set (5/6/7/9/13), (b) canonical config list
   (which of the 10 hermes profiles), (c) source-of-truth location
   (memory-bench/ tree, hermes-memory-bench/ tree, or new
   projects/benchmark/memory-bench/ tree).
2. **`i-benchmark-scaffold-memory-bench-harness`** *(mvp)* — Scaffold
   memory-bench/{harness.py, harness_multi.py, audit_coverage.py, statistics/,
   elo/, tasks/} using hermes-memory-bench as structural model. Depends on #1.
3. **`i-benchmark-wire-configs-into-harness`** *(mvp)* — Register the chosen
   config roster in harness.py and add `--configs` / `--tasks` filters to
   harness_multi.py. Depends on #2.
4. **`i-benchmark-coverage-audit-and-backfill`** *(mvp)* — Run audit_coverage.py
   to confirm the matrix, backfill any cell with rep_count < 3, regenerate
   statistics/summary.json (total_runs ≥ 120) and elo/rankings.json. Depends
   on #3.

## Orphan cleanup

The earlier decompose (azqz49) created a duplicate HITL child
`hitl-locate-or-scaffold-memory-bench-har` (state=blocked, never claimed by a
human, recommendation=(c) cancel parent). It is functionally superseded by the
merged `hitl-benchmark-locate-memory-bench-harness` and will be cancelled
during the ledger writes below to keep the parent tree clean.

## Files in this worktree

- `evidence.md` (this file)

## Out of scope for this slice

- Resolving E-043 (the HITL child #1 carries this).
- Writing the harness code (the mvp children #2/#3/#4 carry this).
- Running API calls (the mvp child #4 carries this; pre-approval required for
  the API budget it implies).

## Next worker

The factory will pick up the new children in priority order:
- HITL #1 will wait for human input; the other 3 mvp children are gated on
  it via the cascade-on-merge trigger.
- Each mvp child gets its own worktree, its own branch, its own evidence file.
