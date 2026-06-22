---
name: diff-review
description: "Pre-commit phase. Independent subagent reviews the finalized diff against the task brief + touched ADRs, returns a structured report of consequences, surprises, gaps, and ADR conflicts. Worker logs the report as a ledger event before bookie will accept a merged state update."
---

# diff-review — Independent Pre-Commit Diff Review

A worker self-reviewing its own diff misses what it rationalized away during implementation. This skill spawns a **fresh subagent** that has never seen the worker's reasoning, gives it only `(diff, task brief, touched ADR files)`, and asks it to predict consequences and flag surprises/gaps versus the brief.

Mandatory before `bookie update --state merged`. The ledger CLI refuses merge if no `diff_review` event exists for the issue.

## When to run

After the diff is finalized (all code/test/doc edits done) and before `git add` / `git commit`. If you change the diff after running, run again — the report is only valid for the diff at capture time.

## Inputs the subagent receives

1. `git diff` against the branch's merge base (raw patch, no commentary).
2. The task row's `body_md` + `acceptance_md`.
3. Full contents of any ADR file referenced by the brief or touched by the diff.

Nothing else — no event log, no chat history, no prior reasoning. Independence is the point.

## Required output schema

```json
{
  "consequences": ["predicted runtime/API/schema/hook/test/caller/doc effect"],
  "surprises_vs_brief": ["diff content not implied by brief or referenced ADRs"],
  "gaps_vs_brief": ["brief/ADR requirement not delivered by the diff"],
  "adr_conflicts": ["diff content that contradicts a touched ADR's stated rule"],
  "axi_violations": ["agent-facing output that violates an AXI principle (only when the diff changes such output)"]
}
```

Empty arrays are valid (expected for clean, in-scope diffs). `axi_violations` is empty whenever the diff touches no agent-consumed CLI/tool output — most diffs. The ledger gate checks only that a `diff_review` event exists, not its fields, so the extra key is backward-compatible.

## Procedure (worker side)

1. Capture the diff: `git diff $(git merge-base HEAD origin/main)..HEAD` (or `--cached` if staged).
2. Capture the brief: `bun bin/ledger.ts show <task-id>`, extract `body_md` + `acceptance_md`.
3. Identify touched ADRs: any `docs/adr/*.md` in the diff, plus ADRs cited in the brief.
4. Spawn an independent reviewer via `Agent` tool with `subagent_type: general-purpose` (no shared context). Prompt below.
5. Validate the returned JSON parses against the schema. If malformed, re-prompt once; if still malformed, fail loud and decompose.
6. Address every `surprises_vs_brief`, `gaps_vs_brief`, `adr_conflicts` entry by either editing the diff (then re-running) or including an explicit justification in `evidence_md` at merge time naming each unresolved item.
7. Ask the bookie subagent (via Agent tool) to log the report as `kind=diff_review` with the JSON object as payload. Bookie writes via `bin/ledger.ts event`; the worker does not invoke the CLI directly (all-writes-through-bookie rule).
8. Proceed to `git add` / `git commit` / push / PR.

## Reviewer prompt template

```
You are an independent diff reviewer. You have not seen the worker's
reasoning or chat history. You see only the diff, the task brief, and the
referenced ADR text. Predict the change's consequences and compare to the brief.

Return ONLY a JSON object matching this schema:
{
  "consequences": string[],
  "surprises_vs_brief": string[],
  "gaps_vs_brief": string[],
  "adr_conflicts": string[],
  "axi_violations": string[]
}

- consequences: predicted runtime shifts, API/schema/migration effects, hook
  firing changes, test surface, downstream caller impact, doc implications.
- surprises_vs_brief: scope creep, refactors not asked for, files touched
  the brief did not name.
- gaps_vs_brief: missed acceptance criteria, tests not added, docs not updated.
- adr_conflicts: diff content that contradicts a rule in a touched ADR.
- axi_violations: ONLY if the diff changes output an agent consumes (CLI/tool
  results, status, query answers). Flag against AXI (axi.md): redundant fields
  the consumer restates, unbounded bodies dumped with no gist/--full escape
  hatch, missing empty-state/exit-code, no next-step template. Empty [] for any
  diff that touches no agent-facing output — do not invent violations.

No editorializing. No output outside the JSON object.

=== TASK BRIEF ===
<body_md>

=== ACCEPTANCE ===
<acceptance_md>

=== TOUCHED ADRS ===
<adr-file path + contents, repeat>

=== DIFF ===
<git diff output>
```

## Enforcement

- `bin/ledger.ts update --state merged` refuses if no `kind=diff_review` event exists.
- Bookie mirrors the rule in its hard-refusal list (`.claude/agents/bookie.md` rule #7).
- The gate applies to `merged` because that is when scope creep ships.

## When NOT to run

- Doc-only edits with no code change AND no ADR touched (still safer to run).
- Reverts where the diff is exactly the inverse of a single prior commit.

If you skip, leave a `note` event explaining why before asking bookie to merge.
