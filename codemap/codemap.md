---
generated: 2026-06-30T23:25:37.721Z @ab1b289
project: arc-agents
ecosystems: [node, typescript]
source_files: 58
test_files: 74
graph_source: regex (approximate)
graph_analyzed: true
dead_count: 0
untested_count: 2
cycle_count: 0
tool: codemap
---

# Codemap — arc-agents

> Deterministic static snapshot (no LLM). Re-run after changes and diff `codemap.json` to see what moved.

> ⚠ **Import graph is regex-approximate** — `madge` not installed, so edges (hence dead/cycle signals) may include false positives from import-like text in comments or strings. Install for AST-accurate edges: `npm i -g madge`.

## Module shapes (LOC by module)
_Modules = import communities (Louvain over the import graph)._

- `bin` — 4722 LOC
- `src/ledger` — 2713 LOC
- `src/ledger::worker-lifecycle` — 1707 LOC
- `src/ledger::ux-config` — 989 LOC
- `src/starlight-hats` — 712 LOC
- `memory-bench` — 475 LOC
- `bin::deploy-preview` — 314 LOC
- `src/director` — 77 LOC
- `src/profiles` — 47 LOC
- `src/steering` — 44 LOC

## Seams (cross-module import edges)

- src/ledger -> src/ledger::ux-config — 4
- src/ledger -> src/ledger::worker-lifecycle — 4
- src/ledger::worker-lifecycle -> bin — 2
- src/ledger::ux-config -> bin — 2
- src/ledger -> bin — 2
- bin -> src/ledger::ux-config — 2
- src/ledger::worker-lifecycle -> src/ledger::ux-config — 1

## Layout vs clustering (dir ↔ community)

_Modules grouped by import community, not folder. Disagreements are architecture leads._

**Directory split across communities** (leaky boundary / candidate split):
- `bin/` → 5 communities: bin, bin::deploy-preview, src/ledger, src/ledger::ux-config, src/ledger::worker-lifecycle
- `src/ledger/` → 5 communities: bin, bin::deploy-preview, src/ledger, src/ledger::ux-config, src/ledger::worker-lifecycle

**Community spanning directories** (cross-cutting / candidate merge):
- `src/ledger` ← bin, src/config, src/director, src/ledger, src/profiles, src/worker
- `src/ledger::worker-lifecycle` ← bin, src/factory, src/ledger
- `bin` ← bin, src/interviewer, src/ledger
- `src/ledger::ux-config` ← bin, src/ledger
- `bin::deploy-preview` ← bin, src/ledger

## Dead code candidates (0)

_Source files with no inbound import and not an entrypoint. Verify before deleting — dynamic/CLI/plugin loads aren't seen._


## Untested source (2)

_No test file imports it and no sibling test exists. Heuristic — wire up coverage for precision._

- `src/factory/worker-lifecycle.ts`
- `src/ledger/hitl-schemas.ts`

## Import cycles (0)

_none detected_

## Possible redundancy

**Same exported symbol from multiple files** (higher signal — but verify: client/server pairs and shared type contracts legitimately share a name):
- `triageUnset` → `bin/factory.ts`, `src/factory/worker-lifecycle.ts`
- `reapFinished` → `bin/factory.ts`, `src/factory/worker-lifecycle.ts`
- `FeedbackRow` → `bin/feedback-aggregate.ts`, `src/director/director-brief.ts`
- `loadConfig` → `src/config/load.ts`, `src/ledger/ux-config.ts`
- `LedgerRow` → `src/director/director-brief.ts`, `src/director/mission-gap.ts`
- `sweepStaleClaims` → `src/factory/worker-lifecycle.ts`, `src/ledger/claim-stale-sweeper.ts`

**Same filename in multiple dirs** (low signal — often normal per-package structure):
- `deploy-preview.ts` ×2
- `pre-drafter.ts` ×2
- `load.ts` ×2


## Config files (5)

- `.github/workflows/release-gate.yml`
- `.gitignore`
- `memory-bench/.gitignore`
- `package.json`
- `tsconfig.json`

## Top external deps

- `bun:test` — 71 imports
- `node:path` — 59 imports
- `node:fs` — 53 imports
- `node:os` — 41 imports
- `bun:sqlite` — 41 imports
- `node:child_process` — 31 imports
- `node:url` — 20 imports
- `bun` — 9 imports
- `fs` — 7 imports
- `path` — 6 imports
- `__future__` — 5 imports
- `pathlib` — 5 imports
- `sys` — 5 imports
- `zod` — 5 imports
- `harness` — 4 imports
- `typing` — 3 imports
- `argparse` — 3 imports
- `json` — 3 imports
- `subprocess` — 3 imports
- `child_process` — 2 imports
- `yaml` — 2 imports
- `crypto` — 2 imports
- `pytest` — 2 imports
- `harness_multi` — 2 imports
- `os` — 1 imports

## Docs with frontmatter (0)

