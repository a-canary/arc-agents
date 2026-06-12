Before `git add` / `git commit`, run the `/diff-review` skill: spawn an
independent subagent (no shared reasoning trace) that reviews the finalized
diff against the task brief + touched ADRs and returns a structured report
of consequences, surprises_vs_brief, gaps_vs_brief, and adr_conflicts.

**Project-field verification (mandatory, pre-review).** Before spawning
the reviewer, capture the row's `project` field from
`bin/ledger.ts show <id>`. Pass it to the subagent in a new prompt
section between brief and diff (`=== ROW PROJECT FIELD === <value> ===`
and `=== PR_URL (if filed) === <url> ===`). The subagent must run this
3-line check before reading the diff:

```bash
EXPECTED_REPO="a-canary/${PROJECT}"
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

Fixture: `project=cli-proxy, pr_url=https://github.com/a-canary/cli-proxy/pull/1` → `EXPECTED_REPO=a-canary/cli-proxy, ACTUAL_REPO=a-canary/cli-proxy`, check passes.

Ask the bookie subagent to log the returned JSON as a ledger event
(`kind=diff_review`, payload = the JSON object). All ledger writes go
through bookie — do not invoke `bin/ledger.ts event` directly.

Reconcile every surprise/gap by editing the diff (and re-running the
review) OR by naming the unresolved item in `evidence_md` at merge time.

The ledger CLI refuses `update --state=merged` if no `diff_review` event
exists for the task. Bookie mirrors the rule.
