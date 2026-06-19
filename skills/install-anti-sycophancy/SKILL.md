---
name: install-anti-sycophancy
description: Install a UserPromptSubmit + Stop hook pair that reminds the model to avoid sycophancy without bloating the system prompt.
---

# install-anti-sycophancy

The `anti-sycophancy` skill describes the rules. This installer wires them into the harness so they apply by default, without requiring the model to invoke the skill explicitly.

## What gets installed

Two hooks in the harness settings (default: `~/.claude/settings.json`):

1. **UserPromptSubmit** — injects a one-line reminder before each user turn so the rules stay in attention.
2. **Stop** — runs a quick self-check on the final assistant message and logs sycophantic patterns for later review.

## Hook scripts written

### `~/.claude/hooks/anti-sycophancy-inject.sh`

```bash
#!/usr/bin/env bash
# UserPromptSubmit hook — emits a short reminder via stdout.
cat <<'EOF'
[anti-sycophancy] Reply directly. No validation openers, no hedging filler, no closing flattery. Disagree explicitly when warranted.
EOF
```

### `~/.claude/hooks/anti-sycophancy-check.sh`

```bash
#!/usr/bin/env bash
# Stop hook — scan the last assistant message for sycophancy patterns.
# Reads transcript path from $CLAUDE_TRANSCRIPT_PATH (or arg 1).
transcript="${CLAUDE_TRANSCRIPT_PATH:-${1:-}}"
[[ -z "$transcript" || ! -f "$transcript" ]] && exit 0

last=$(tail -200 "$transcript" | tr -d '\r')
patterns=(
  "Great question"
  "You're absolutely right"
  "That's a really"
  "Hope (this|that) helps"
  "Let me know if you'd like"
  "Just to clarify"
)
hits=()
for p in "${patterns[@]}"; do
  if echo "$last" | grep -Ei "$p" >/dev/null; then
    hits+=("$p")
  fi
done

if [[ ${#hits[@]} -gt 0 ]]; then
  ts=$(date -u +%FT%TZ)
  echo "{\"ts\":\"$ts\",\"hits\":$(printf '%s\n' "${hits[@]}" | jq -R . | jq -s -c .)}" \
    >> ~/.cache/arc-skills/anti-sycophancy.log
fi
exit 0
```

## settings.json patch

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/anti-sycophancy-inject.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/anti-sycophancy-check.sh" }
        ]
      }
    ]
  }
}
```

## CLI

```bash
install-anti-sycophancy                  # dry-run: print scripts + settings diff
install-anti-sycophancy --apply          # write scripts, merge settings.json (with backup)
install-anti-sycophancy --apply --scope project   # write to .claude/settings.json instead
install-anti-sycophancy uninstall        # remove scripts + revert settings block
```

## Install procedure

```
1. Check ~/.claude/ exists (else: ask user for harness config dir)
2. Write the two hook scripts; chmod +x
3. Back up settings.json → settings.json.bak.<ts>
4. Merge hook entries into settings.json (preserve existing hooks; dedupe by command path)
5. Print: "Installed. Restart your harness session for hooks to take effect."
```

## Detection of other harnesses

If `~/.claude/` does not exist, prompt for:
- Cursor: `~/.cursor/hooks/` (different schema)
- Aider: no hook system; suggest `--message` injection instead
- Custom: ask for the hook directory and settings file path

## What this does NOT do

- It does not modify the system prompt directly (that's harness-specific and brittle)
- It does not block messages — the Stop hook only logs
- It does not auto-edit your replies — the reminder is the only injection
