---
name: analyse-recent-sessions
description: "Read N recent worker tmux scrollbacks / handoff events, identify recurring friction, write a new skill or update an existing one."
---

# analyse-recent-sessions — Mine Recent Worker Traces for Patterns

Use when a hygiene worker has scrollback and event-log access to a window of recent worker sessions and wants to convert recurring friction into a durable skill update (per the "Pattern Detection & Root-Cause Discipline" rule in `roles/AGENTS.md` / the doctrine loaded by every role).

This skill is the explicit, on-demand counterpart to the stop-hook's `ke-learn`: instead of one session's takeaways, it spans N sessions and looks for shape.

## When to use

- ≥3 recent worker rows showed the same failure mode, the same wasted exploration, or the same hand-holding question.
- A new skill landed recently and you want to check whether workers are actually invoking it correctly.
- The director suspects a class of work is consistently over-budget and wants evidence before re-shaping the workflow.

Do **not** use this skill to debug a single failed row — use `triage-failed` for that. The minimum signal here is N≥3 rows showing the same shape.

## Inputs expected

- A time window or a row-id list (e.g. "last 24h of `class=hygiene` workers" or `["row-a", "row-b", "row-c"]`).
- Access to the ledger event log and (where available) tmux scrollback under `~/vault/agents/<role>/journal/`.
- A hypothesis to test, or "open-ended" if scanning for any pattern.

## Deliverable shape

1. A short markdown report under `~/vault/agents/director/inbox/analysis-<unix-ts>.md` containing:
   - **Window:** time range + row count examined.
   - **Pattern(s) found:** each pattern named, with ≥3 row-ids as evidence.
   - **Root cause hypothesis:** one paragraph per pattern.
   - **Recommended action:** either (a) a new skill (name + one-paragraph charter), (b) an edit to an existing skill (path + one-line diff intent), or (c) a CHOICES / ADR proposal.
2. If recommendation is (a) or (b) **and** the change is slice-bounded (≤30 lines), the slice may include the SKILL.md edit. Otherwise file a follow-up ledger row and link the analysis report from it.
3. A ledger `event` of `kind=note` on each of the N evidence rows pointing to the analysis report path (delegate the write to the bookie subagent — workers do not write to the ledger directly).

## Slice budget

- Time: ≤90 min (reading scrollback is slow).
- Rows examined: ≥3, ≤20 (above 20, the signal is no longer slice-shaped — file an umbrella row).
- Diff: ≤30 lines of code/skill changes within this slice (recommendations beyond that become follow-up rows).

## Verification

- The pattern names ≥3 distinct rows that exhibit it.
- The recommended action is concrete enough that a future worker could execute it without further interpretation.
- If a SKILL.md was edited inline, `bun run typecheck` is still green and the edit is small enough to fit the slice budget.

## Termination

### `merged` — hard gate sequence

**Step 1 — Stage the analysis report.**

```bash
TARGET_DIR="~/vault/agents/director/inbox"
REPORT_PATH="$TARGET_DIR/analysis-<unix-ts>.md"
mkdir -p "$TARGET_DIR"
# ... write the report to $REPORT_PATH
```

Stage it in vault (never push vault). The report path is passed to `--body` in Step 2.

**Step 2 — File follow-up rows via `hygiene-emit` (delegated to bookie via Agent tool).**

Workers must NOT write to the ledger directly — all writes route through bookie. Do not invoke `bin/ledger.ts hygiene-emit` yourself. Instead:

1. **Parse** the follow-up table in bash to extract titles.
2. **Delegate** each row to the bookie subagent (at the worker orchestration level, not inside bash).

The bookie subagent will invoke: `bin/ledger.ts hygiene-emit --skill analyse-recent-sessions --title "<title>" --body "$REPORT_PATH" --observed-in-task "<CURRENT_TASK>"`

Extract titles from the follow-up table (columns: `#`, `Title (slug)`, `Type`, `Notes`, `LOC`):

```bash
CURRENT_TASK="<current ledger row id>"

# Extract table rows after the "## Recommended follow-up rows" heading.
# Skip the markdown header delimiter line (|---|...).
FOLLOWUP_BLOCK=$(awk '/^## Recommended follow-up rows/,0' "$REPORT_PATH" | awk 'NR>2 && /\| [A-Z0-9]/ {print}')
echo "$FOLLOWUP_BLOCK" | while IFS='|' read -r _ num title notes loc; do
  # Design: awk over jq for stdlib portability — jq may not be available on all factory worker shells. See §"awk over jq for stdlib portability" in Design notes below.
  title=$(echo "$title" | xargs)
  if [ -z "$title" ]; then continue; fi
  echo "$title"
done
```

For each extracted title, delegate `hygiene-emit` to the bookie subagent (one call per title).

Bookie handles dedup automatically against ready/blocked/wip/claimed hygiene rows with the same skill and a similar title.

**Valid skills for `--skill`:** `clarify-docs`, `improve-architecture`, `trash-retired-files`, `analyse-recent-sessions`. All hygiene-emit rows are created as `type=quality tier=hygiene`. Dedup is automatic against ready/blocked/wip/claimed rows with the same skill + similar title.

**If the table is empty (0 follow-ups):** this step is a no-op; proceed to Step 4.

**Step 3 — Annotate evidence rows with `note` events (delegated to bookie via Agent tool).**

Workers must NOT write to the ledger directly — all writes route through bookie. Do not invoke `bin/ledger.ts event` yourself. Collect row IDs in bash, then delegate event writes to the bookie subagent:

```bash
echo "Collecting evidence row IDs..."
# Design: awk + while is stdlib; no jq dependency (same rationale as Step 2 above). See §"awk over jq for stdlib portability" in Design notes below.
ROW_IDS=$(awk '/^## Pattern [0-9]/,/^## / { if (/row-[a-z]|^`[a-z0-9-]+`$/ || /`[a-z0-9-]{10,}`/) print }' \
  "$REPORT_PATH" | grep -oE '`[a-z0-9-]{10,}`' | tr -d '`' | sort -u)
echo "Rows to annotate: $ROW_IDS"
```

For each row ID, delegate `kind=note` to the bookie subagent (not inside bash — at the worker orchestration level).

**Step 4 — Update parent row to merged via bookie (Agent tool).**

After all hygiene-emit + event calls succeed, delegate to bookie (workers must NOT write to the ledger directly). The report lives in vault (never pushed), so analysis-only rows are **zero-diff** — this is the normal case:
```
Agent tool → bookie subagent: update <id> --state merged --no-diff --in-place --evidence "<one-liner summary + $REPORT_PATH>"   # evidence ≤280 chars
```
Only use `--pr <url-or-branch>` when the row also shipped a real diff (then emit exactly **one** `diff_review` event for that sha — re-emitting 3–5× is ledger noise, pipeliner rows 000229/000256). Never open an empty PR to satisfy the merge guard.

**Merge gate:** merged state is accepted only when `hygiene_complete=1` on the row. `hygiene-emit` sets this atomically. If the follow-up table was empty, delegate `--hygiene-complete` to bookie via Agent tool (workers must NOT write to the ledger directly).

**PR (if any):** file a PR, get an independent reviewer to return no blockers, then merge to main.

### `failed`

Couldn't find a pattern with N≥3 evidence. Record the negative result in evidence (still useful — rules out a hypothesis). Delegate to bookie: `update --state failed --evidence "no pattern found in N rows examined"`.

### `blocked`

Pattern points at a decision only the human can make (e.g. "switch model tier for class=hygiene"). Decompose into a HITL child carrying the analysis report and the proposed action. Delegate to bookie: `decompose <task-id> --child "<HITL step>"`.

## Design notes

### awk over jq for stdlib portability

All inline data extraction in this skill uses `awk` (POSIX stdlib) rather than `jq`.
Rationale: `jq` is not guaranteed to be available on all factory worker shells,
especially container-based or minimal environments. `awk` is part of POSIX and
present on virtually every Unix-like system. The two locations annotated with
this design note are:
- Follow-up row extraction loop (Step 2, line 81 — inline `# Design: awk over jq...` comment).
- Evidence row annotation loop (Step 3, line 102 — inline `# Design: awk + while...` comment).

## Pattern shortlist (already documented — point future analyses here)

If a new analysis surfaces a pattern that matches one of these, the analysis should cite the existing ADR and recommend either (a) refining the doc with new evidence, or (b) filing a follow-up row for a layered defense. Do **not** re-litigate the design.

- **30-min watchdog vs compute-heavy ML tasks** → `docs/adr/0008-vast-operator-pattern.md` (operator runs the compute on a vast.ai lease; worker lands the finding). The 11-row evidence base (4 successful + 7 eventually-successful) is in `~/vault/agents/director/journal/analysis-1780697137.md` Pattern 3. A new analysis that sees `exit 124` + `tier=compute`-shaped + a KE note mentioning "operator" or "vast" should reference ADR 0008, not re-propose the design.
- **Worker dies after PR-merge on GitHub → ledger stuck in `review` → `berzerk-port-reconcile` recovers** → no ADR yet; documented as the dominant factory-wide failure shape (12 `exited 124` events across arc-agents, arc-webui, expert-horde, cli-proxy). Evidence base in `~/vault/agents/director/journal/analysis-1782187417.md` Pattern 2 (2 expert-horde rows rescued by reconcile at ts=1782179493, Tracer 3 + 000082). A new analysis that sees a row in `state=review` with PR `mergedAt` predating the latest event AND `agent=berzerk-port-reconcile` in the event log should cite this entry, not re-propose the reconcile mechanism. Recovery is by-design (bookie merge-guard + reconcile cron); investigate rising death-rate separately via `investigate-worker-died-post-pr-merge-frequ` follow-up.
- **Operator ran the compute AFTER the worker failed → no `operator_landed` event → row stuck in `state=failed` despite artifacts on disk** → `docs/adr/0008-vast-operator-pattern.md` §"Operator-completion hook (Pattern 3)". Evidence: Round-2 capacity probe (worker died at ts=1782463477, vast run SUCCESS'd ~40min later on box 42453957, row stayed `failed` — `analysis-1782813826.md` Pattern 3). The new event kind `operator_landed` (migration `026_event_kind_operator_landed`) is the operator's audit-trail hook. A new analysis that sees a compute-bearing row in `state=failed` with no `operator_landed` event in the log AND artifacts in `.run-artifacts/`/`artifacts/` on disk should cite ADR-0008 §Pattern 3 and recommend either (a) emitting the event retroactively from the operator side, or (b) filing a bookie `failed → ready` follow-up gated on `operator_landed`. Do NOT recommend reviving the row directly — the hook is the durable fix.
- **`exit 127 = "pi: command not found"` hygiene cron crash (factory-wide)** → already factory-acknowledged in `bin/factory.test.ts:370` + `bin/worker-shell.sh:151`; partial fix landed in `358b01f fix(worker): probe ~/node_modules/.bin in ensure_pi_on_path` 2026-06-29 but did not cover all code paths. Evidence base: 9 exit-127 events in last 30d; 4 consecutive hygiene rows `000120`/`000121`/`000122`/`000123` all failed in 7d (`analysis-1782770508.md` Pattern 1, `analysis-1782965639.md` Pattern 1). The defence-in-depth `hygiene-cron-dedup-against-recent-failures` follow-up was attempted but lost to a worktree-destruction incident (see `~/vault/agents/director/inbox/worker-hygiene-cron-dedup-recovery.md`) and re-filed by `analysis-1782965639.md` Pattern 2. A new analysis that sees a row in `state=failed` with `exit 127` AND a hygiene tier AND 0 commits AND a recent same-`(project,skill)` failed row should cite this entry + the dedup follow-up, not re-propose the path-resolution fix.
- **`alias-cmd` failover chain exhausted (`rc=1` → `rc=141` escalation) → engine starts but produces no commits** → first documented in `analysis-1783332184.md` Pattern 1 (21 events, 8 projects, 30d at `rc=1`); the `ensure_claude_afk_on_path` fix in PR #311 / commit 1dc9082 (2026-07-06) advanced the rc signature from `1` to `141` (SIGPIPE = 128+13) — engine now starts AND begins output but is killed mid-flight. Evidence base for the escalation: 5 events in 5d post-fix across arc-agents, arc-skills, starlight-slm (`analysis-1783764179.md` Pattern 1). The follow-up `improve-architecture-engine-alias-failov` (merged) addressed the path-restoration branch only; the engine-lifecycle branch (response timeout / pipe-close timing) is the open half. Already-queued durable fixes: `alias-cmdline-ownership-registry-driven-` (arc-agents, failed 2026-07-09, Aaron ruling 2026-07-10) and `add-the-ordered-failover-chain-to-the-tr` (ke, blocked). A new analysis that sees `kind='failed'` events with `headless reconcile: all N candidate engine(s) for alias 'X' produced no work (last rc=1|141)` should cite this entry, not re-propose the path-resolution fix. See also the next shortlist entry (`claim-stale-sweeper` runaway loop), which is the same root cause viewed from the sweeper side. **Confirmed alias-agnostic 2026-08-04** (`analysis-1785884093.md`): the same `engine-alias-no-work:<alias>` shape recurred for alias `minimax-build` across 5 hygiene rows in a 4-min recovery-sweep window (rc=0/1, `blocked→ready` cycling every ~30-60min via `recovery-sweep`) — same dispatcher-level failure, different named alias. Do not re-file per-alias; the fix belongs in engine selection, not alias config.
- **`claim-stale-sweeper` runaway loop on `rc=141` rows — 1000+ reclaim cycles per row in <16h** → first documented in `analysis-1783764179.md` Pattern 2 (4 rows, 13,687 reclaim cycles in 5d, ~6s/cycle). The factory sweeper reclaims a row indefinitely when every worker exits with no commits + no self-report, regardless of how many recent failures the row already has. Cross-cuts with the prior shortlist entry (`alias-cmd` rc=141) — same root cause (engine never advances the row), but the *symptom* is the sweeper, not the engine. Evidence: `000165-hygiene-starlight-slm-trash-retired-file` reached 9553 reclaims in 15.6h before going `failed`; `add-the-machine-submitter-denylist-const` / `apply-the-same-exclusion-to-the-projects` / `verify-the-auto-oversight-skill-stamps-t` had 1136–1533 reclaims each in 2.5h at analysis time. A new analysis that sees an issue with ≥100 reclaim events in ≤16h AND a `kind='failed'` payload matching the `alias-cmd` shortlist entry should cite BOTH entries, not re-propose the sweeper. The durable fix is a "recent-failure cooldown" on the sweeper (skip rows with N failures in the last M minutes); structurally identical to the `hygiene-cron-dedup-against-recent-failures` follow-up from `analysis-1782770508.md` Pattern 1 that was lost to a worktree-destruction incident.
