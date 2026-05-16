---
name: claude-afk
description: "Headless-shaped invocation of `claude` that runs inside an interactive tmux pane you can attach to live. Gives you the shape of `claude -p --output-format json` with full transparency: every turn is observable in real time, attachable mid-flight, and inspectable after the fact via the session log."
---

# claude-afk — Observable Headless `claude`

## When to use

You want the shape of `claude -p --output-format json` (give prompt, block, get JSON, exit), but you also want to *see what the agent is doing* while it runs — not just the final JSON.

Applies when:
- You're orchestrating one-shot agentic invocations from scripts, cron, or other agents.
- You want to be able to `tmux attach` mid-run to watch tool use, intervene, or debug.
- You want the full session transcript available after exit, not just the summarized `result`.

Primary value is **transparency and observability**: a real Claude Code session under the hood means you get the same UI, the same tool-call rendering, the same scrollback, and the same hook surface as if you'd typed the prompt yourself.

(Side benefit: because the work runs inside an interactive Claude Code session, it bills against the Max plan's Claude-Code bucket rather than the extra-usage/API bucket — useful if you're on Max with extra-usage off. Not the reason to reach for this skill, just a happy side effect.)

## Contract (what callers can rely on)

Input:
```
claude-afk <prompt>                              # positional, required
  [--system-prompt <str>]                        # optional system prompt
  [--out <path>]                                 # JSON output path; default: mktemp
  [--timeout <seconds>]                          # kill session after N sec; default: 1800
  [--session-prefix <str>]                       # tmux session name prefix; default: "afk"
```

Behavior:
1. Mints a unique tmux session name.
2. Writes a hermetic per-invocation settings file containing a Stop hook that emits JSON.
3. Spawns `tmux new-session -d` running `claude` with `--settings <hermetic>` and the prompt.
4. Blocks until the JSON file appears OR the timeout fires.
5. Kills the tmux session.
6. Prints the JSON to stdout. Exits 0 on success, nonzero on timeout / hook failure / missing output.

Output JSON shape (matches `claude -p --output-format json` enough for drop-in):
```json
{
  "result": "<final assistant message>",
  "session_id": "<claude session uuid>",
  "exit_reason": "stop" | "timeout" | "error",
  "duration_ms": 12345
}
```

Callers MUST pass a unique `--out` if invoking concurrently. The default `mktemp` already does this; only override if you need a known path.

## Mechanism

Two parts: a Stop hook that writes the result, and a wrapper that spawns + waits.

### Stop hook (hermetic, written per invocation)

Stop hooks receive input as **JSON on stdin** (not env vars). Available fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `stop_hook_active`. There is **no `last_assistant_message`** on Stop (that field exists on SubagentStop). The result must be extracted from the transcript JSONL.

Settings file written to a tempfile, passed via `claude --settings`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/claude-afk-stop-hook.sh"
          }
        ]
      }
    ]
  }
}
```

The hook script reads stdin, extracts session_id and transcript_path, walks the transcript JSONL for the last assistant message, and writes JSON to `$CLAUDE_AFK_OUT` (set in the tmux session env by the wrapper). Atomic write: `.tmp` then `mv`, so the wrapper's poll never sees a partial file.

```bash
#!/usr/bin/env bash
# claude-afk-stop-hook.sh — Stop hook body
set -euo pipefail
INPUT=$(cat)
SESSION_ID=$(jq -r '.session_id' <<<"$INPUT")
TRANSCRIPT=$(jq -r '.transcript_path' <<<"$INPUT")
# Last assistant message: walk transcript JSONL, take the last entry whose
# .message.role == "assistant", concat its text content blocks.
LAST=$(jq -s '[.[] | select(.message.role=="assistant")] | last
              | .message.content
              | map(select(.type=="text") | .text) | join("\n")' "$TRANSCRIPT")
jq -n --argjson r "$LAST" --arg s "$SESSION_ID" \
  '{result:$r, session_id:$s, exit_reason:"stop"}' \
  > "$CLAUDE_AFK_OUT.tmp"
mv "$CLAUDE_AFK_OUT.tmp" "$CLAUDE_AFK_OUT"
```

### Wrapper

```bash
#!/usr/bin/env bash
# claude-afk <prompt> [--out <path>] [--timeout <sec>] [--system-prompt <str>] [--session-prefix <str>]
set -euo pipefail

PROMPT=""
OUT=""
TIMEOUT=1800
SYS=""
PREFIX="afk"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --system-prompt) SYS="$2"; shift 2 ;;
    --session-prefix) PREFIX="$2"; shift 2 ;;
    *) PROMPT="$1"; shift ;;
  esac
done

[ -z "$PROMPT" ] && { echo "usage: claude-afk <prompt> [flags]" >&2; exit 2; }

OUT="${OUT:-$(mktemp -t claude-afk.XXXXXX.json)}"
SETTINGS="$(mktemp -t claude-afk-settings.XXXXXX.json)"
HOOK="$(mktemp -t claude-afk-hook.XXXXXX.sh)"
SESSION="${PREFIX}-$(tr -dc a-z0-9 </dev/urandom | head -c8)"

cat >"$HOOK" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
SESSION_ID=$(jq -r '.session_id' <<<"$INPUT")
TRANSCRIPT=$(jq -r '.transcript_path' <<<"$INPUT")
LAST=$(jq -s '[.[] | select(.message.role=="assistant")] | last
              | .message.content
              | map(select(.type=="text") | .text) | join("\n")' "$TRANSCRIPT")
jq -n --argjson r "$LAST" --arg s "$SESSION_ID" \
  '{result:$r, session_id:$s, exit_reason:"stop"}' \
  > "$CLAUDE_AFK_OUT.tmp"
mv "$CLAUDE_AFK_OUT.tmp" "$CLAUDE_AFK_OUT"
SH
chmod +x "$HOOK"

jq -n --arg cmd "$HOOK" \
  '{hooks:{Stop:[{matcher:"",hooks:[{type:"command",command:$cmd}]}]}}' \
  > "$SETTINGS"

START=$(date +%s%3N)

tmux new-session -d -s "$SESSION" \
  -e "CLAUDE_AFK_OUT=$OUT" \
  "claude --settings '$SETTINGS' ${SYS:+--append-system-prompt \"$SYS\"} $(printf '%q' "$PROMPT")"

# Poll for output or timeout
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ ! -s "$OUT" ]; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$SETTINGS" "$HOOK"
    jq -n --argjson d "$(( $(date +%s%3N) - START ))" \
      '{result:"", session_id:"", exit_reason:"timeout", duration_ms:$d}'
    exit 124
  fi
  sleep 1
done

tmux kill-session -t "$SESSION" 2>/dev/null || true
END=$(date +%s%3N)

jq --argjson d "$(( END - START ))" '. + {duration_ms:$d}' "$OUT"
rm -f "$SETTINGS" "$HOOK" "$OUT"
```

Save as `~/.local/bin/claude-afk`, `chmod +x`. Drop-in callers replace `claude -p --output-format json` with `claude-afk`.

## Caller responsibilities

- **Concurrency**: default `mktemp` output is unique per invocation. Only pass `--out` if you have a reason; if you do, ensure uniqueness.
- **Tools / permissions**: hermetic settings only override hooks. Permissions and MCP config come from the user's global `~/.claude/settings.json`. If you need stricter perms for one-shot use, extend the hermetic settings file in the wrapper.
- **Failure surfacing**: check `.exit_reason`. `stop` = clean. `timeout` = wrapper killed the session. `error` = caller convention if you extend the hook to detect refusals.

## Non-goals (v1)

- **Streaming**: no `--output-format stream-json` equivalent. Block-and-return only.
- **Resume**: no `--resume <id>`. Each invocation is a fresh session. (Could be added by passing `--resume` through to `claude` if `session_id` known.)
- **Non-tmux supervisors**: tmux only. Porting to screen/zellij/plain pty is mechanical but out of scope.
- **MCP injection**: caller's global MCP config applies.

## Why not just a binary?

This skill *is* the product. The "binary" is 60 lines of bash that the user already has all the dependencies for (`tmux`, `claude`, `jq`). Shipping it as a skill keeps:

- **Zero install surface** beyond dropping one shell script in `$PATH`.
- **No version skew** with Claude Code's hook contract — if Anthropic changes hook env vars, you edit the skill.
- **Honest scope**: this is a recipe, not infrastructure.

## Relationship to arc-agents

arc-agents uses the same mechanism (interactive `claude` in tmux, Stop hook for signaling) but does not need claude-afk because it dispatches via the ledger rather than blocking on JSON output. claude-afk is for *other* systems — cron jobs, scripts, agents — that already speak `claude -p` and want the observability of a live tmux pane (and, incidentally, Max-bucket billing) without re-architecting around a ledger.
