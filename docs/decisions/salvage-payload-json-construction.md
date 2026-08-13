# Decision: Salvage Payload — jq `--arg`/`--argjson` Instead of printf Raw Interpolation

**Date:** 2026-08-13
**Status:** accepted
**Row:** `clarify-docs-worker-shell-base-head-bran`
**Source:** `bin/worker-shell.sh` ponytail annotation (line 669)
**Observed in:** `000242-hygiene-arc-agents-ponytail-audit`

---

## TL;DR

The `salvage_payload_json()` function constructs a JSON object for the
structured handoff event at the end of the headless reconcile path. It
originally used `printf` with raw string interpolation (`%s`), relying on
the fact that all interpolated values (git SHAs, refnames, a GitHub URL)
never contained characters that would break JSON (`"`, `\`, newlines). To
eliminate this latent brittleness, the function was rewritten to use
`jq -nc --arg/--argjson`, which handles all JSON escaping correctly
regardless of input content.

## Before / After

```diff
-salvage_payload_json() {
-  local pr="$6"
-  local pr_json="null"
-  [[ -n "$pr" ]] && pr_json="\"$pr\""
-  printf '{"kind":"salvage","base":"%s","head":"%s","commits":%d,"branch":"%s","exit_code":%d,"pr_url":%s,"reason":"commits present, no terminal self-report"}' \
-    "$1" "$2" "$3" "$4" "$5" "$pr_json"
-}
+salvage_payload_json() {
+  jq -nc \
+    --arg base "$1" \
+    --arg head "$2" \
+    --argjson commits "$3" \
+    --arg branch "$4" \
+    --argjson exit_code "$5" \
+    --arg pr "${6:-}" \
+    '{
+      kind: "salvage",
+      base: $base,
+      head: $head,
+      commits: $commits,
+      branch: $branch,
+      exit_code: $exit_code,
+      pr_url: (if $pr == "" then null else $pr end),
+      reason: "commits present, no terminal self-report"
+    }'
+}
```

## Rationale

- **Defense in depth.** The old code was correct for current inputs (git
  SHAs are hex, URLs are URL-safe), but the ponytail pattern encourages
  eliminating every "this is safe because..." assumption. `jq --arg`
  guarantees correct JSON output for any string value.

- **One fewer manual JSON construction.** The old code had to special-case
  the `pr_url` field (empty → `null`, non-empty → `"<value>"`). `jq`'
  conditional (`if $pr == "" then null else $pr end`) handles this
  declaratively.

- **jq is already a dependency.** `worker-shell.sh` already uses `jq`
  elsewhere (e.g., parsing `config.json`). Using it for JSON output
  avoids adding new tooling.

- **No performance concern.** `jq -nc` (null-input, compact output) is
  a single subprocess spawn that completes in <10ms — negligible in a
  path that already spawns a multi-minute LLM session.

## Call site

The function is called once per headless reconcile attempt, right after
the worker advances the row to `state=review`:

```bash
SALVAGE_JSON="$(salvage_payload_json "$BASELINE_SHA" "$HEAD_FULL" "$COMMITS_AHEAD" "$WT_BRANCH" "$AGENT_RC" "$DISCOVERED_PR")"
bun "$LEDGER_BIN" event "$CLAIM_ID" note "$SALVAGE_JSON" "${DB_FLAG[@]}" --agent "$WORKER" >/dev/null 2>&1 || true
```

The emitted event has `kind=note` and payload matching the JSON schema:
`{kind, base, head, commits, branch, exit_code, pr_url, reason}`.

## Cross-references

- `bin/worker-shell.sh` — `salvage_payload_json()` (line ~42), call site (line ~670)
- `000242-hygiene-arc-agents-ponytail-audit` — the hygiene run that surfaced this
  as undocumented
- `docs/adr/0001-ephemeral-workers.md` — worker lifecycle, headless reconcile path
