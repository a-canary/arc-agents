# ponytail-audit: arc-agents

Task: 000242-hygiene-arc-agents-ponytail-audit

## Summary

Scanned arc-agents repo for `ponytail:` annotations — inline developer markers noting edge cases, design decisions, and architectural watch-items.

**33 markers found** across 20 files. Categorized into:

- **30 clarify-docs** hygiene tasks emitted
- **1 improve-architecture** hygiene task emitted

## Markers Found

### bin/feedback-aggregate.ts (5)
- L32: Collector is one no-tools MiniMax call, degrades to 'general' on failure
- L46: webui-side stamping of mode/author_trust lands in arc-webui repo; here we only READ
- L114: null submitter counts as own distinct source for anonymous feedback
- L299: validation in pass 2 is just "is row still merged" — no body-similarity scoring
- L461: keyed on row count only — edited-in-place row won't re-trigger
  → hygiene: 5 clarify-docs tasks

### bin/plan-agent.ts (3)
- L69: richer grounding via CONTEXT.md/ADRs + ke recall is follow-up enrichment (slice 4)
- L84: repo is sibling of arc-agents (../<project>); missing file degrades gracefully
- L266: glob over `ledger list --kind prd` cheaper than new SQL query
  → hygiene: 3 clarify-docs tasks

### bin/director-governor.ts (2)
- L84: sentinel-file flags are simplest reactive control — existsSync
- L116: per-Director attribution is hard — tokens not tagged by director; uses host-wide weekly sum
  → hygiene: 1 clarify-docs + 1 improve-architecture

### bin/vast-billing.ts (2)
- L68: VASTAI_BIN explicit env var, same contract as vast-lease
- L107: temp+rename atomic pattern, not lock — one writer per instance
  → hygiene: 2 clarify-docs tasks

### bin/vast-lease.ts (1)
- L239: --dph on acquire is OPTIONAL; records labelled estimate for reconcile
  → hygiene: 1 clarify-docs task

### bin/vast-lease.test.ts (1)
- L163: --dph is labelled-estimate handoff to vast-billing; not deep-tested here
  → hygiene: clarify-docs (dedup)

### bin/vast-billing.test.ts (1)
- L29: single fixture-based test harness; production call mocked via VASTAI_BIN
  → hygiene: clarify-docs (dedup)

### bin/ledger.ts (2)
- L831: success is strict — every blocker must be merged AND nothing missing
- L1611: linear probe over handful of worktree dirs (orphan-first case)
  → hygiene: 2 clarify-docs tasks

### bin/worker-shell.sh (2)
- L306: cheap fetch + merge --ff-only; no merge conflict possible by construction
- L657: base/head/branch/pr_url interpolated raw — all git SHAs/URLs, JSON stays valid
  → hygiene: 2 clarify-docs tasks

### src/ledger/migrate.ts (3)
- L1136: source is free string, not CHECK'd — domain model says trust tier
- L1213: resolution is free TEXT not CHECK'd enum — only 'superseded' today
- L1248: no CHECK constraints on webui-owned feedback table
  → hygiene: 3 clarify-docs tasks

### src/ledger/merge-truth.ts (1)
- L181: kill on timeout to prevent corrupt .git hanging validator forever
  → hygiene: 1 clarify-docs task

### src/ledger/cross-repo-gate.ts (1)
- L15: mention-based heuristic; false positives cost 2h park + opus call
  → hygiene: 1 clarify-docs task

### bin/estate-secret-inventory.ts (1)
- L5: wraps gitleaks instead of hand-rolling regex
  → hygiene: 1 clarify-docs task

### bin/merge-gate.sh (1)
- L79: heal missing node_modules in fresh worktree
  → hygiene: 1 clarify-docs task

### bin/gate-triage.ts (1)
- L15: no schema change — stamp lives in body_md
  → hygiene: 1 clarify-docs task

### bin/plan.ts (1)
- L112: full sequential chain; per-slice dependency edges if parallel slices ever matter
  → hygiene: 1 clarify-docs task

### bin/recovery-sweep.ts (1)
- L18: probe only first candidate — one alive = alias produces work
  → hygiene: 1 clarify-docs task

### bin/trash-sweep.test.ts (1)
- L49: sweep_after must stay ahead of wall-clock or fixture rots
  → hygiene: 1 clarify-docs task

### skills/analyse-recent-sessions/SKILL.md (3)
- L68: hygiene-emit is ledger CLI write; workers delegate to bookie
- L76: no jq dependency — awk is stdlib
- L98: awk + while is stdlib; no jq needed
  → hygiene: 2 clarify-docs tasks

## Hygiene Tasks Emitted (31 total)

| ID | Skill | Title |
|---|---|---|
| clarify-docs-feedback-aggregate-collecto | clarify-docs | feedback-aggregate: collector design — one no-tools MiniMax call, degrades to 'general' on failure |
| clarify-docs-feedback-aggregate-null-sub | clarify-docs | feedback-aggregate: null submitter counts as distinct source |
| clarify-docs-feedback-aggregate-validati | clarify-docs | feedback-aggregate: validation in pass 2 is just 'is row still merged' |
| clarify-docs-feedback-aggregate-keyed-on | clarify-docs | feedback-aggregate: keyed on row count only, not content hash |
| clarify-docs-feedback-aggregate-webui-si | clarify-docs | feedback-aggregate: webui-side stamping of mode/author_trust lands in arc-webui repo |
| clarify-docs-plan-agent-richer-grounding | clarify-docs | plan-agent: richer grounding — read CONTEXT.md/ADRs + ke recall |
| clarify-docs-plan-agent-repo-is-sibling- | clarify-docs | plan-agent: repo is sibling of arc-agents (../project) |
| clarify-docs-plan-agent-glob-over-ledger | clarify-docs | plan-agent: glob over ledger list --kind prd |
| clarify-docs-director-governor-sentinel- | clarify-docs | director-governor: sentinel-file flags |
| improve-architecture-director-governor-p | improve-architecture | director-governor: per-Director attribution is hard — tokens aren't tagged by director |
| clarify-docs-vast-billing-explicit-env-v | clarify-docs | vast-billing: explicit env var contract |
| clarify-docs-vast-billing-temp-rename-at | clarify-docs | vast-billing: temp+rename atomic pattern |
| clarify-docs-vast-lease-dph-on-acquire-i | clarify-docs | vast-lease: --dph on acquire is OPTIONAL, records labelled estimate |
| clarify-docs-ledger-success-is-strict-ev | clarify-docs | ledger: success is strict — every blocker must be merged AND nothing missing |
| clarify-docs-ledger-linear-probe-over-a- | clarify-docs | ledger: linear probe over a handful of worktree dirs |
| clarify-docs-worker-shell-fetch-merge-ff | clarify-docs | worker-shell: fetch+merge --ff-only pattern |
| clarify-docs-worker-shell-base-head-bran | clarify-docs | worker-shell: base/head/branch/pr_url raw interpolation |
| clarify-docs-migrate-source-is-free-stri | clarify-docs | migrate: source is free string, not CHECK'd |
| clarify-docs-migrate-resolution-is-free- | clarify-docs | migrate: resolution is free TEXT not CHECK'd enum |
| clarify-docs-migrate-no-check-constraint | clarify-docs | migrate: no CHECK constraints on webui-owned feedback table |
| clarify-docs-merge-truth-kill-on-timeout | clarify-docs | merge-truth: kill on timeout to prevent .git hang |
| clarify-docs-cross-repo-gate-mention-bas | clarify-docs | cross-repo-gate: mention-based heuristic for cross-repo linking |
| clarify-docs-estate-secret-inventory-wra | clarify-docs | estate-secret-inventory: wraps gitleaks instead of hand-rolling regex |
| clarify-docs-merge-gate-heal-missing-nod | clarify-docs | merge-gate: heal missing node_modules in fresh worktree |
| clarify-docs-gate-triage-block-review-st | clarify-docs | gate-triage: block/review stamp lives in body_md not schema |
| clarify-docs-plan-full-sequential-chain- | clarify-docs | plan: full sequential chain dependency pattern |
| clarify-docs-recovery-sweep-probe-only-f | clarify-docs | recovery-sweep: probe only first candidate |
| clarify-docs-trash-sweep-fixture-sweep-a | clarify-docs | trash-sweep fixture: sweep_after must stay ahead of wall-clock |
| clarify-docs-analyse-recent-sessions-hyg | clarify-docs | analyse-recent-sessions: hygiene-emit is ledger CLI write, workers delegate to bookie |
| clarify-docs-analyse-recent-sessions-use | clarify-docs | analyse-recent-sessions: uses awk not jq for stdlib portability |

## Files Scanned (no ponytail annotations — clean)

All `.ts`, `.sh`, `.md` files in the arc-agents repo were scanned.
