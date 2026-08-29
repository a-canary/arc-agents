Before `git add` / `git commit`, run the `/diff-review` skill: spawn an
independent subagent (no shared reasoning trace) that reviews the finalized
diff against the task brief + touched ADRs and returns a structured report
of consequences, surprises_vs_brief, gaps_vs_brief, adr_conflicts, and
axi_violations (the last only when the diff changes agent-facing output).

**Project-field verification (mandatory, pre-review).** Before spawning
the reviewer, capture the row's `project` field from
`bin/ledger.ts show <id>`. Pass it to the subagent in a new prompt
section between brief and diff (`=== ROW PROJECT FIELD === <value> ===`
and `=== PR_URL (if filed) === <url> ===`). The subagent must run this
3-line check before reading the diff:

```bash
# Resolve local project name -> GitHub remote. Add new aliases here when
# introducing a new project whose ledger `project` field differs from its
# GitHub repo slug (only confirmed aliases: arc-webui -> webui,
# webui-specs -> webui-specs, conjecture -> Conjecture — verified
# 2026-06-30 from trash-retired-files-conjecture-drop-dead PR #19,
# starlight-slm -> Starlight-SLM — verified 2026-07-07 from PRs #8+#19,
# onenation -> OurNation — verified 2026-08-04 from origin remote + PR #227).
case "${PROJECT}" in
  arc-webui)    EXPECTED_REPO="a-canary/webui" ;;
  webui-specs)  EXPECTED_REPO="a-canary/webui-specs" ;;
  conjecture)   EXPECTED_REPO="a-canary/Conjecture" ;;
  starlight-slm) EXPECTED_REPO="a-canary/Starlight-SLM" ;;
  trading)      EXPECTED_REPO="a-canary/Trading" ;;
  onenation)    EXPECTED_REPO="a-canary/OurNation" ;;
  *)            EXPECTED_REPO="a-canary/${PROJECT}" ;;
esac
ACTUAL_REPO="$(echo "$PR_URL" | sed -E 's|.*github.com/([^/]+/[^/]+)/pull/.*|\1|')"
[ "$EXPECTED_REPO" = "$ACTUAL_REPO" ] || { echo "PR repo mismatch: expected $EXPECTED_REPO, got $ACTUAL_REPO"; exit 2; }
```

Empty/missing `project` field (e.g. arc-agents internal rows whose home
repo is arc-agents by default) → skip the check entirely; no false
positive. The check exists to catch the "worker committed to the wrong
repo" class of bug (Pattern 4 in
`~/vault/agents/director/journal/analysis-1780502957.md` — the 5
cli-proxy rows that filed PRs against arc-agents). Pair this with the
bookie merge guard (which catches the same class of bug at merge time)
for defense in depth.

**Project-name alias map.** Most rows follow `project=<local-repo-dir>`
→ `remote=a-canary/<local-repo-dir>`. Three confirmed exceptions
(sampled 2026-06-26 from `issues.pr_url`, dominant PR repo per
`project` column; starlight-slm added 2026-07-07):

| project (ledger) | remote (GitHub) | evidence |
| --- | --- | --- |
| `arc-agents` | `a-canary/arc-agents` | 214 PRs, dominant |
| `arc-webui` | `a-canary/webui` | 17 PRs (3 anomalies to `arc-agents` — the bug) |
| `webui-specs` | `a-canary/webui-specs` | 1 PR (1 anomaly to `arc-agents`) |
| `arc-skills` | `a-canary/arc-skills` | 6 PRs |
| `pipeliner` | `a-canary/pipeliner` | 6 PRs |
| `ke` | `a-canary/ke` | 8 PRs |
| `discord-bridge` | `a-canary/discord-bridge` | 7 PRs |
| `conjecture` | `a-canary/Conjecture` | 1 PR (#19, capital C) |
| `starlight-slm` | `a-canary/Starlight-SLM` | 2 PRs (#8, #19, capital S-L-M) |
| `trading` | `a-canary/Trading` | 1 PR (#166, capital T — verified 2026-07-11) |
| `onenation` | `a-canary/OurNation` | origin remote + PR #227 (verified 2026-08-04) |

When adding a new project whose local directory name differs from its
GitHub repo slug, extend the `case` block above in this same order and
keep the table in sync. When in doubt, run
`bun bin/ledger.ts list --project <name> --state merged --json` and
confirm the dominant `pr_url` repo before assuming the default
`a-canary/${PROJECT}` template is right.

Fixture: `project=cli-proxy, pr_url=https://github.com/a-canary/cli-proxy/pull/1` → `EXPECTED_REPO=a-canary/cli-proxy, ACTUAL_REPO=a-canary/cli-proxy`, check passes.
Fixture (aliased): `project=arc-webui, pr_url=https://github.com/a-canary/webui/pull/29` → `EXPECTED_REPO=a-canary/webui, ACTUAL_REPO=a-canary/webui`, check passes (would have FAILED under the naive `a-canary/${PROJECT}` template — the bug this fix exists to prevent).

**Reject error-shaped reviewer output (mandatory).** Before emitting the
`diff_review` event, inspect the reviewer envelope/output. A channel error is
NOT a review:
- `claude-afk` rc=0 with `exit_reason:"error"`, or result text shaped like a
  channel failure ("Not logged in", "API Error", rate-limit message, empty)
  → treat as NO REVIEW. Never emit a verdict from that output and never
  paraphrase/repair error text into a pass payload.
- Retry once via the fallback channel: `pi -p --no-session "<prompt>"` (fresh
  process, still independent). If both channels return error-shaped output,
  fail loudly or decompose — do not merge without a real review.
The emitted payload must be the reviewer's actual JSON report.
Subagents inherit `GH_TOKEN` from the worker shell (`ensure_gh_token_on_env`),
so `gh` API calls work inside the reviewer without extra setup.

Ask the bookie subagent to log the returned JSON as a ledger event
(`kind=diff_review`, payload = the JSON object). All ledger writes go
through bookie — do not invoke `bin/ledger.ts event` directly.

Reconcile every surprise/gap by editing the diff (and re-running the
review) OR by naming the unresolved item in `evidence_md` at merge time.

The ledger CLI refuses `update --state=merged` if no `diff_review` event
exists for the task. Bookie mirrors the rule.
