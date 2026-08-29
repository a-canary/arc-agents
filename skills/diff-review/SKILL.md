---
name: diff-review
description: "Pre-commit phase. Independent subagent reviews the finalized diff against the task brief + touched ADRs, returns a structured report of consequences, surprises, gaps, and ADR conflicts. Worker logs the report as a ledger event before bookie will accept a merged state update."
---

# diff-review — Independent Pre-Commit Diff Review

A worker self-reviewing its own diff misses what it rationalized away during implementation. This skill spawns a **fresh subagent** that has never seen the worker's reasoning, gives it only `(diff, task brief, touched ADR files)`, and asks it to predict consequences and flag surprises/gaps versus the brief.

Mandatory before `bookie update --state merged`. The ledger CLI refuses merge unless the **latest `diff_review` event** parses as JSON of shape:

```json
{
  "reviewer_identity": "<distinct from the row's claimed_by>",
  "reviewed_sha":      "<7–40 hex chars>",
  "verdict":           "pass" | "fail" | "comment"
}
```

Self-review (reviewer_identity === row.claimed_by) is rejected. Legacy payloads (`{consequences, surprises_vs_brief, gaps_vs_brief, adr_conflicts}`) parse as JSON objects but are missing the required fields and are rejected as well — the gate requires the new contract. The reviewer may still produce a report with `consequences/axi_violations/...` keys; those keys are simply ignored by the parser.

The remaining schema (`consequences, surprises_vs_brief, gaps_vs_brief, adr_conflicts, axi_violations`) is the reviewer's *content*; it lives outside the gate and should still be emitted for auditability. Wrap the contract fields together with the report in one event payload:

```json
{
  "reviewer_identity": "claude-afk-reviewer",
  "reviewed_sha":      "$(git rev-parse HEAD)",
  "verdict":           "pass",
  "consequences":      [],
  "surprises_vs_brief": [],
  "gaps_vs_brief":     [],
  "adr_conflicts":     [],
  "axi_violations":    []
}
```

## When to run

After the diff is finalized (all code/test/doc edits done) and before `git add` / `git commit`. If you change the diff after running, run again — the report is only valid for the diff at capture time.

## Inputs the subagent receives

1. `git diff` against the branch's merge base (raw patch, no commentary).
2. The task row's `body_md` + `acceptance_md`.
3. Full contents of any ADR file referenced by the brief or touched by the diff.

Nothing else — no event log, no chat history, no prior reasoning. Independence is the point.

## Required output schema (audit content, sent with the contract fields above)

```json
{
  "consequences": ["predicted runtime/API/schema/hook/test/caller/doc effect"],
  "surprises_vs_brief": ["diff content not implied by brief or referenced ADRs"],
  "gaps_vs_brief": ["brief/ADR requirement not delivered by the diff"],
  "adr_conflicts": ["diff content that contradicts a touched ADR's stated rule"],
  "axi_violations": ["agent-facing output that violates an AXI principle (only when the diff changes such output)"]
}
```

Empty arrays are valid (expected for clean, in-scope diffs). `axi_violations` is empty whenever the diff touches no agent-consumed CLI/tool output — most diffs. The legacy gate accepted this body alone — it now rejects it because the three contract fields (`reviewer_identity`, `reviewed_sha`, `verdict`) are missing. **Always emit all three contract fields alongside the content.**

## Procedure (worker side)

1. Capture the diff: `git diff $(git merge-base HEAD origin/main)..HEAD` (or `--cached` if staged).
2. Capture the brief: `bun bin/ledger.ts show <task-id>`, extract `body_md` + `acceptance_md`.
3. Identify touched ADRs: any `docs/adr/*.md` in the diff, plus ADRs cited in the brief.
4. Spawn an independent reviewer. The canonical channel depends on the worker
   harness (the reviewer inherits `GH_TOKEN` from the worker shell via
   `ensure_gh_token_on_env` in bin/worker-shell.sh, so `gh` API calls work
   inside the reviewer without extra setup):

   - **Headless claude workers (default):** spawn via `claude-afk` — observable headless claude in tmux, hermetic settings, no shared hooks. Example:
     ```bash
     claude-afk "$(cat <<'PROMPT'
     <reviewer prompt template>
     PROMPT
     )" --timeout 600 --session-prefix diff-review > /tmp/diff-reviewer.json
     ```
     Then extract: `RESULT=$(jq -r '.result' /tmp/diff-reviewer.json)`.

     Gotcha: panes inherit the **tmux server** env, not the spawning shell's.
     If the server predates the auth token exports, claude-afk returns rc=0
     with `{"result":"Not logged in · Please run /login","exit_reason":"error"}`
     — an error-shaped result, NOT a review (fb-vdur, fb-ntc1, fb-qhk4).
     Check the envelope before trusting `.result`. If it is error-shaped,
     fall back to `pi -p --no-session "<prompt>"` (fresh process, still
     independent; extract JSON from the tail if stop-hook noise follows).

   - **pi-coding-agent workers:** `Agent` / `Task` is NOT a built-in tool — it ships as the opt-in subagent extension at `examples/extensions/subagent/` inside the `@earendil-works/pi-coding-agent` package. If your pi profile loads that extension, dispatch via `pi -p` (or its RPC mode) instead of `claude-afk`. The contract is the same: an isolated session that has never seen the worker's reasoning.

   - **No spawn channel at all (rare, harness-limited):** if neither `claude-afk` nor a subagent extension is available, perform the review **in the worker process** but emit the contract under an `reviewer_identity` that **names the limitation honestly** (e.g. `arc-webui-direct-self-review-no-agent-tool`), include a `self_review_limitation` field in the payload body explaining what was missing, and keep the rest of the schema intact. The merge gate accepts this because `reviewer_identity` differs from `claimed_by`; the SPIRIT of independence is weakened but visible. Operator may re-review via a fresh claude/haiku session if desired. **Always prefer installing the subagent extension over relying on this fallback.**
5. **Reject error-shaped output before parsing.** rc=0 with
   `exit_reason:"error"`, or result text shaped like a channel failure
   ("Not logged in", "API Error", rate-limit message, empty) means NO REVIEW
   happened — never emit a verdict from that output and never paraphrase it
   into a pass payload (2026-08-28: a `"Not logged in"` result nearly became
   a bogus `diff_review` event). On error-shaped output, retry once via the
   next channel in step 4; if all channels fail, fail loud and decompose.
   Then validate the returned JSON parses against the schema. If malformed,
   re-prompt once; if still malformed, fail loud and decompose.
6. Address every `surprises_vs_brief`, `gaps_vs_brief`, `adr_conflicts` entry by either editing the diff (then re-running) or including an explicit justification in `evidence_md` at merge time naming each unresolved item.
7. Emit the report as a ledger event:
   ```bash
   {
     echo "$RESULT" | jq --arg rid "$(git config user.name)-$(date +%s%N)" \
                          --arg sha "$(git rev-parse HEAD)" \
                          '. + {reviewer_identity:$rid, reviewed_sha:$sha, verdict:(.verdict // "pass")}';
   } > /tmp/diff-review.contract.json
   jq -c . /tmp/diff-review.contract.json
   bun bin/ledger.ts event <task-id> diff_review "$(jq -c . /tmp/diff-review.contract.json)" --agent bookie
   ```
   `reviewer_identity` must NOT match the row's `claimed_by` (worker self-review is rejected). `reviewed_sha` is the commit the reviewer inspected (typically `HEAD` on the worker branch). `verdict` is `pass`, `fail`, or `comment` — the merge gate does not gate on verdict value, only on shape + independence.
   This is the only ledger write in the diff-review workflow (the reviewer is the read-only subagent, not a ledger actor).
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

## Harness-specific spawn channel (cheat sheet)

| Worker harness | Spawn command | Independent? |
| --- | --- | --- |
| `claude -p` headless (arc-agents default) | `claude-afk ... --session-prefix diff-review` | Yes (fresh session, hermetic settings, no shared hooks) |
| pi-coding-agent (with subagent extension loaded) | `pi -p` or RPC mode dispatched by an extension | Yes (fresh subagent with no shared reasoning) |
| pi-coding-agent (no extension loaded) | direct self-review with honest `reviewer_identity` label | No (same reasoning trace); document via `self_review_limitation` field |
| Any worker, spawn channels auth-broken | `pi -p --no-session "<prompt>"` — fresh process, JSON from tail if stop-hook noise follows | Yes (fresh session) |

If the table doesn't match your harness, fix the table — don't silently fall back.

## Enforcement

- `bin/ledger.ts update --state merged` refuses unless the **latest** `kind=diff_review` event for the issue parses as the contract JSON and the `reviewer_identity` differs from the row's `claimed_by`.
- Bookie mirrors the rule in its hard-refusal list (`.claude/agents/bookie.md` rule #7).
- The gate applies to `merged` because that is when scope creep ships.

## When NOT to run

- Doc-only edits with no code change AND no ADR touched (still safer to run).
- Reverts where the diff is exactly the inverse of a single prior commit.

If you skip, leave a `note` event explaining why before asking bookie to merge.
