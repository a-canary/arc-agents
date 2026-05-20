---
name: claude-afk
description: "Headless-shaped invocation of `claude` that runs inside an interactive tmux pane you can attach to live. Gives you the shape of `claude -p --output-format json` with full transparency: every turn is observable in real time, attachable mid-flight, and inspectable after the fact via the session log."
---

# claude-afk — Observable Headless `claude`

## When to use

You want the shape of `claude -p --output-format json` (give prompt, block, get JSON, exit), but you also want to *see what the agent is doing* — not just the final JSON.

- One-shot agentic invocations from scripts, cron, or other agents.
- `tmux attach` mid-run to watch tool use, intervene, or debug.
- Full session transcript available after exit, not just summarized `result`.

Primary value is **observability**: a real Claude Code session under the hood gives you the same UI, tool-call rendering, scrollback, and hook surface as if you'd typed the prompt yourself. (Side benefit: bills against the Max plan's Claude-Code bucket rather than extra-usage.)

## Contract

```
claude-afk <prompt>                              # positional, required
  [--system-prompt <str>]
  [--out <path>]                                 # default: mktemp
  [--timeout <seconds>]                          # default: 1800
  [--session-prefix <str>]                       # default: "afk"
```

Behavior: mints a tmux session, writes a hermetic settings file with a Stop hook that emits JSON, spawns `tmux new-session -d` running `claude --settings <hermetic>` with the prompt, blocks until JSON appears or timeout fires, kills the tmux session, prints JSON to stdout. Exits 0 on success, nonzero on timeout / hook failure.

Output JSON (matches `claude -p --output-format json` for drop-in):
```json
{
  "result": "<final assistant message>",
  "session_id": "<claude session uuid>",
  "exit_reason": "stop" | "timeout" | "error",
  "duration_ms": 12345
}
```

Pass a unique `--out` if invoking concurrently. The default `mktemp` already does this.

## Mechanism

Stop hooks receive JSON on stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `stop_hook_active`. There is **no `last_assistant_message`** on Stop (that's SubagentStop) — extract from the transcript JSONL.

### Stop hook (hermetic, written per invocation)

```bash
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
```

Atomic write (`.tmp` then `mv`) so the wrapper's poll never sees a partial file.

### Wrapper

```bash
#!/usr/bin/env bash
set -euo pipefail
PROMPT=""; OUT=""; TIMEOUT=1800; SYS=""; PREFIX="afk"
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

cp /path/to/claude-afk-stop-hook.sh "$HOOK"   # or inline as in skill
chmod +x "$HOOK"

jq -n --arg cmd "$HOOK" \
  '{hooks:{Stop:[{matcher:"",hooks:[{type:"command",command:$cmd}]}]}}' \
  > "$SETTINGS"

START=$(date +%s%3N)
tmux new-session -d -s "$SESSION" \
  -e "CLAUDE_AFK_OUT=$OUT" \
  "claude --settings '$SETTINGS' ${SYS:+--append-system-prompt \"$SYS\"} $(printf '%q' "$PROMPT")"

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
jq --argjson d "$(( $(date +%s%3N) - START ))" '. + {duration_ms:$d}' "$OUT"
rm -f "$SETTINGS" "$HOOK" "$OUT"
```

Save as `~/.local/bin/claude-afk`, `chmod +x`. Replace `claude -p --output-format json` calls with `claude-afk`.

## Caller notes

- Hermetic settings only override hooks; permissions/MCP come from `~/.claude/settings.json`. Extend the hermetic settings if you need stricter perms.
- Check `.exit_reason`: `stop` = clean, `timeout` = wrapper killed the session.
- No streaming, no resume, tmux-only. Caller's global MCP config applies.

## Relationship to arc-agents

arc-agents uses the same mechanism (interactive `claude` in tmux, Stop hook for signaling) but dispatches via the ledger rather than blocking on JSON output. claude-afk is for *other* systems — cron jobs, scripts, agents — that speak `claude -p` and want observability of a live tmux pane without re-architecting around a ledger.
