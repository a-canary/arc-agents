---
name: diff-review
description: "Pre-commit phase. Independent subagent reviews the finalized diff against the task brief + touched ADRs, returns a structured report of consequences, surprises, gaps, and ADR conflicts. Worker logs the report as a ledger event before bookie will accept a merged state update."
---

# diff-review — Independent Pre-Commit Diff Review

A worker self-reviewing its own diff misses what it rationalized away during implementation. This skill spawns a **fresh subagent** that has never seen the worker's reasoning trace, gives it only `(diff, task brief, touched ADR files)`, and asks it to predict consequences and flag surprises/gaps versus the brief.

The skill is mandatory before `bookie update --state merged`. The ledger CLI refuses merge if no `diff_review` event exists for the issue.

## When to run

Run **after** the diff is finalized (all code/test/doc edits done, no further work planned) and **before** `git add` / `git commit`. If you change the diff after running the review, run it again — the report is only valid for the diff at the time of capture.

## Inputs the subagent receives

1. `git diff` against the branch's merge base (raw patch text, no commentary).
2. The task row's `body_md` + `acceptance_md` (the brief).
3. Full contents of any ADR file referenced by the brief or touched by the diff.
4. The row's `project` field and (if filed) the `pr_url` — see "Project-field verification" below.

The subagent receives **nothing else** — no event log, no worker chat history, no prior reasoning. Independence is the whole point.

## Required output schema

The subagent returns a single JSON object:

```json
{
  "consequences": [
    "string — one predicted runtime/API/schema/hook/test/caller/doc effect of the diff"
  ],
  "surprises_vs_brief": [
    "string — diff content not implied by the task brief or referenced ADRs"
  ],
  "gaps_vs_brief": [
    "string — brief/ADR requirement not delivered by the diff"
  ],
  "adr_conflicts": [
    "string — diff content that contradicts a touched ADR's stated rule"
  ]
}
```

Empty arrays are valid (and expected for clean, in-scope diffs).

## Procedure (worker side)

1. Capture the diff: `git diff $(git merge-base HEAD origin/main)..HEAD` (or `git diff --cached` if already staged).
2. Capture the brief: `bun bin/ledger.ts show <task-id>` and extract `issue.body_md` + `issue.acceptance_md` + `issue.project` + `issue.pr_url`.
3. Identify touched ADRs: any `docs/adr/*.md` file in the diff, plus any ADR explicitly cited in the brief.
4. Spawn an independent reviewer via the `Agent` tool with `subagent_type: general-purpose` (no shared context). Prompt template below.
5. Validate the returned JSON parses and matches the schema. If not, re-prompt once for fix; if still malformed, fail loud and decompose.
6. Address every `surprises_vs_brief`, `gaps_vs_brief`, and `adr_conflicts` entry by **either**:
   - editing the diff to reconcile, then re-running this skill, **or**
   - including an explicit justification in the row's `evidence_md` at merge time, naming each unresolved item.
7. Ask the bookie subagent (via the Agent tool) to log the report as `kind=diff_review` with the JSON object as the payload. Bookie writes via `bin/ledger.ts event`; the worker does not invoke the CLI directly (all-writes-through-bookie rule).
8. Proceed to `git add` / `git commit` / push / PR.

## Project-field verification (mandatory precondition)

Before the subagent reads the diff, it must verify the row's `project` field matches the `pr_url`'s github repo. This catches the "worker committed to the wrong repo" class of bug (Pattern 4 in `~/vault/agents/director/journal/analysis-1780502957.md` — the 5 cli-proxy rows that filed PRs against `a-canary/arc-agents` instead of `a-canary/cli-proxy`).

The worker passes two new sections to the subagent (between `=== ACCEPTANCE ===` and `=== DIFF ===`):

```
=== ROW PROJECT FIELD ===
<value of issue.project, e.g. "cli-proxy" — may be empty/null for arc-agents internal rows>

=== PR_URL (if filed) ===
<value of issue.pr_url — may be null if not yet filed>
```

The subagent runs this 3-line bash check **before** reading the diff:

```bash
EXPECTED_REPO="a-canary/${PROJECT}"
ACTUAL_REPO="$(echo "$PR_URL" | sed -E 's|.*github.com/([^/]+/[^/]+)/pull/.*|\1|')"
[ "$EXPECTED_REPO" = "$ACTUAL_REPO" ] || { echo "PR repo mismatch: expected $EXPECTED_REPO, got $ACTUAL_REPO"; exit 2; }
```

- If `PROJECT` is empty/missing (arc-agents internal rows) → skip the check, no false positive.
- If `PR_URL` is missing and `PROJECT` is set → skip the check (no PR to verify against yet; the bookie merge guard fires at merge time as the last line of defense).
- If both are set and the regex produces an `ACTUAL_REPO` that doesn't match → exit 2 before reading the diff. The subagent reports the mismatch in `surprises_vs_brief`.

Fixture: `project=cli-proxy, pr_url=https://github.com/a-canary/cli-proxy/pull/1` → `EXPECTED_REPO=a-canary/cli-proxy`, `ACTUAL_REPO=a-canary/cli-proxy`, check passes.

## Reviewer prompt template

```
You are an independent diff reviewer. You have not seen the worker's
reasoning or chat history. You see only the diff, the task brief, and the
referenced ADR text. Your job is to predict the change's consequences and
compare them to the brief.

Return ONLY a JSON object matching this schema:
{
  "consequences": string[],
  "surprises_vs_brief": string[],
  "gaps_vs_brief": string[],
  "adr_conflicts": string[]
}

Definitions:
- consequences: predicted runtime behavior shifts, API contract changes,
  schema/migration effects, hook firing changes, test surface affected,
  downstream caller impact, doc/spec implications. Be specific.
- surprises_vs_brief: diff content not implied by the brief or any cited
  ADR. Scope creep. Refactors not asked for. Files touched the brief did
  not name.
- gaps_vs_brief: brief or ADR requirements the diff does not satisfy.
  Missed acceptance criteria. Tests not added. Docs not updated.
- adr_conflicts: diff content that directly contradicts a rule stated in
  a touched ADR.

Do not editorialize. Do not output anything outside the JSON object.

=== TASK BRIEF ===
<body_md>

=== ACCEPTANCE ===
<acceptance_md>

=== ROW PROJECT FIELD ===
<project — may be empty for arc-agents internal rows>

=== PR_URL (if filed) ===
<pr_url — may be empty if not yet filed>

=== TOUCHED ADRS ===
<adr-file-1 path + contents>
<adr-file-2 path + contents>
...

=== DIFF ===
<git diff output>
```

## Enforcement

- `bin/ledger.ts update --state merged` refuses if no `kind=diff_review` event exists for the issue id. The error directs the worker to run this skill.
- The bookie subagent mirrors the rule in its hard-refusal list (`.claude/agents/bookie.md` rule #7).
- The check is symmetric for `state=failed` only insofar as failures need evidence; the diff-review gate applies to `merged` because that is when scope creep ships.

## When NOT to run

- Doc-only edits with no code change AND no ADR touched (rare; still safer to run).
- Reverts of a single prior commit where the diff is exactly the inverse.

If you skip the skill for one of these reasons, leave a `note` event explaining why before asking bookie to merge.
