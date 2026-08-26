# Ponytail debt ledger — arc-agents

One-shot harvest of every `ponytail:` comment in the repo (rotating hygiene
cron, task 000287). Format: `<file>:<line>, <what was simplified>. ceiling:
<limit named>. upgrade: <trigger to revisit>`. Comments naming no upgrade
path or trigger carry a `no-trigger` tag — those are the ones that silently
rot.

Scan date: 2026-08-26 (commit 6c1a4c0, main).

## bin/

- `bin/plan-agent.ts:69`, static thin ARCH_CONTEXT string instead of live grounding. ceiling: drafts grounded only in the baked-in context constant. upgrade: slice 4 — read CONTEXT.md/ADRs + `ke recall <request>` and inject here.
- `bin/plan-agent.ts:84`, sibling-repo path assumption (`../<project>`). ceiling: a missing file degrades to the fallback, never throws. upgrade: none named. **no-trigger**
- `bin/plan-agent.ts:266`, glob over `ledger list --kind prd` stdout instead of a new SQL query in bookie. ceiling: parse stdout + filter in memory; trivial at ~hundreds of PRDs vs the LLM call. upgrade: wire real SQL when PRD volume outgrows "trivial".
- `bin/director-governor.ts:82`, sentinel-file flags as reactive control (`existsSync` under a caller-supplied dir). ceiling: no history — who set it, when, why. upgrade: move to a ledger row if history is needed.
- `bin/director-governor.ts:154`, per-Director token attribution via `WEEKLY_TOKENS_<name>` files in the shared sentinel dir. ceiling: file-per-director accounting, no central record. upgrade: none named. **no-trigger**
- `bin/ledger.ts:843`, strict success semantics on blocker wait — every blocker merged AND nothing missing; missing-blocker case refused + re-claimed at the integration step. ceiling: this site papers over nothing, but also does no recovery for a cancelled tracer. upgrade: none named here (see plan.ts:112 for the cancelled-strand note). **no-trigger**
- `bin/ledger.ts:1623`, linear probe over worktree dirs to find a candidate. ceiling: O(n) scan, fine for "a handful" of dirs. upgrade: index/hash when the dir count stops being small.
- `bin/plan.ts:112`, full sequential slice chain — no per-slice dependency edges. ceiling: unblock_dependents releases only on blockers *merged*, so a cancelled tracer strands its successors (failed one is recoverable via `ledger update <tracer> --state ready`). upgrade: per-slice edges from plan-agent if genuinely parallel slices ever matter; recovery for the cancelled case still needed.
- `bin/vast-billing.ts:77`, VASTAI_BIN env-var contract documented in header only. ceiling: contract lives in prose, not enforced. upgrade: none named. **no-trigger**
- `bin/vast-billing.ts:117`, temp+rename write instead of a lock. ceiling: justified by the single-writer-per-instance premise. upgrade: real locking if that premise breaks (two writers per instance).
- `bin/vast-lease.ts:239`, `--dph` on acquire is optional; billing estimate recorded best-effort. ceiling: lease acquire never blocks on billing-tool errors — a failed record means reconcile has nothing to match. upgrade: none named. **no-trigger**
- `bin/worker-shell.sh:318`, guarded `fetch + merge --ff-only` — ancestry-checked, skipped entirely when local default is ahead of or diverged from origin/default. ceiling: safe only while racing cron-pushed merges (local at-or-behind by construction). upgrade: none named for the diverged case beyond skip. **no-trigger**
- `bin/worker-shell.sh:516`, `timeout 5` on `git worktree add` (can hang when nesting worktrees), with detached-worktree fallback. ceiling: 5s is a guess; slow disks may time out into the fallback path. upgrade: none named. **no-trigger**
- `bin/worker-shell.sh:688`, salvage payload JSON built with `jq --arg` escaping. ceiling: correctness note, not a deferral — safe for any content. upgrade: n/a. **no-trigger**
- `bin/feedback-aggregate.ts:36`, Collector is one no-tools MiniMax call; degrades to a single 'general' category on failure. ceiling: per-category counts/patterns computed but UI wiring not done. upgrade: next slice wires /feed + /approvals transparency.
- `bin/feedback-aggregate.ts:50`, webui-side stamping of mode/author_trust lives in the arc-webui repo; this side only reads. ceiling: null = legacy unstamped row → channel fallback. upgrade: none named here (stamp lands upstream). **no-trigger**
- `bin/feedback-aggregate.ts:304`, pass-2 validation is just "is the row still merged" — no body-similarity scoring against the PRD. ceiling: theme_id already expresses the link; validator only catches stale links from post-pass-1 reverts. upgrade: none named. **no-trigger**
- `bin/recovery-sweep.ts:21`, probe only the first candidate of an alias. ceiling: one candidate alive = alias produces work; multi-candidate fallbacks never probed. upgrade: none named for multi-candidate aliases. **no-trigger**
- `bin/estate-secret-inventory.ts:5`, wraps gitleaks instead of hand-rolling regex. ceiling: correctness rides on gitleaks staying installed and being the estate's chosen scanner (secret-scan-gate.sh). upgrade: none named if gitleaks is ever retired. **no-trigger**
- `bin/vast-billing.test.ts:29`, single fixture-based test harness; production `vastai show invoices` mocked at CLI level via VASTAI_BIN. ceiling: no live-API coverage. upgrade: none named. **no-trigger**
- `bin/vast-lease.test.ts:163`, acquire `--dph` handoff to vast-billing shallow-tested (spend.json created + sensible record only). ceiling: deep vast-billing behaviour covered by its own test file, not here. upgrade: none named. **no-trigger**
- `bin/trash-sweep.test.ts:49`, fixture `sweep_after` computed as wall-clock +5y so the fixture stays future-dated. ceiling: rots when wall clock catches up (~2031). upgrade: refresh the fixture when it rots.

## src/ledger/

- `src/ledger/cross-repo-gate.ts:15`, mention-based heuristic for cross-repo targeting. ceiling: false positives cost one 2h park + one opus call; known FP class — an arc-agents row titled "webui: ..." that targets arc-agents' own bin/webui-server.ts (one opus unpark settles it permanently). upgrade: explicit `target-repo:` body marker if minting ever emits one.
- `src/ledger/migrate.ts:1136`, feedback `source` is a free string, not CHECK'd. ceiling: CONTEXT.md says source == trust tier, but arc-webui's form writes channels (direct|public|github) — vocabulary split. upgrade: the gated L1 domain migration adds a CHECK and/or a separate channel column once decided.
- `src/ledger/migrate.ts:1213`, feedback `resolution` is free TEXT, not a CHECK'd enum. ceiling: only verdict pass 2 emits today is 'superseded'. upgrade: future verdicts (e.g. 'duplicate') added when a slice needs them, not speculatively.
- `src/ledger/migrate.ts:1248`, no CHECK constraints on the webui-owned feedback table — intended values documented, not enforced. ceiling: parity with the live table (see 022's rationale); bad values accepted silently. upgrade: none named. **no-trigger**

---

**26 markers, 15 with no trigger.**

Rot-risk note: the `no-trigger` rows are mostly correctness notes or
justifications rather than deferrals (worker-shell.sh:688, vast-lease.test.ts:163,
vast-billing.test.ts:29) — they don't rot, they just aren't debt. The genuine
deferral-without-trigger risks are: `plan-agent.ts:84` (sibling-path
assumption), `worker-shell.sh:516` (5s timeout guess),
`recovery-sweep.ts:21` (first-candidate-only probe), and
`migrate.ts:1248` (un-enforced feedback values).
