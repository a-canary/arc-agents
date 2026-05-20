Before `git add` / `git commit`, run the `/diff-review` skill: spawn an
independent subagent (no shared reasoning trace) that reviews the finalized
diff against the task brief + touched ADRs and returns a structured report
of consequences, surprises_vs_brief, gaps_vs_brief, and adr_conflicts.

Ask the bookie subagent to log the returned JSON as a ledger event
(`kind=diff_review`, payload = the JSON object). All ledger writes go
through bookie — do not invoke `bin/ledger.ts event` directly.

Reconcile every surprise/gap by editing the diff (and re-running the
review) OR by naming the unresolved item in `evidence_md` at merge time.

The ledger CLI refuses `update --state=merged` if no `diff_review` event
exists for the task. Bookie mirrors the rule.
