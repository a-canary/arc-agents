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
  [--model <name>]                               # passed through to claude -p
```

Behavior: mints a tmux session, writes a hermetic settings file spawns `tmux new-session -d` running `claude -p` with the prompt (output teed into the JSON envelope), blocks until JSON appears or timeout fires, kills the tmux session, prints JSON to stdout. Exits 0 on success, nonzero on timeout / hook failure.

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

`claude -p` (headless print mode) runs inside the tmux pane and writes its final
text to a raw file; a trailing `jq` wraps it into the JSON envelope atomically
(`.tmp` then `mv`) so the wrapper's poll never sees a partial file.

History (2026-07-12 rewrite): the original design ran *interactive* `claude`
with a hermetic Stop hook. Three faults killed it in production: (1) the
SESSION random suffix used `tr </dev/urandom | head`, which takes SIGPIPE and
returns rc=141 under `set -euo pipefail`; (2) interactive mode blocks forever
on the trust-folder dialog inside a fresh tmux pane; (3) `--settings` does not
suppress inherited hooks, and the transcript-parsing jq broke on non-array
message content. Headless `-p` removes all three failure surfaces.

### Wrapper

```bash
#!/usr/bin/env bash
# claude-afk — observable headless claude via tmux (attach to watch: tmux attach -t afk-*).
# 2026-07-12 rewrite: run `claude -p` instead of interactive+stop-hook. Fixes three
# faults: (1) SESSION rand pipeline SIGPIPE rc=141 under pipefail, (2) interactive
# mode blocks forever on the trust-folder dialog inside tmux, (3) stop-hook jq
# transcript parse was fragile and --settings did not suppress inherited hooks.
set -euo pipefail
PROMPT=""; OUT=""; TIMEOUT=1800; SYS=""; PREFIX="afk"
while [ $# -gt 0 ]; do
  case "$1" in
    --out)        OUT="$2";       shift 2 ;;
    --timeout)    TIMEOUT="$2";  shift 2 ;;
    --system-prompt) SYS="$2";   shift 2 ;;
    --session-prefix) PREFIX="$2"; shift 2 ;;
    --model)      MODEL="$2";    shift 2 ;;
    -p|--thinking) [ "$1" = "--thinking" ] && shift; shift ;; # tolerated no-ops (alias compat)
    *)            PROMPT="$1";    shift ;;
  esac
done
[ -z "$PROMPT" ] && { echo "usage: claude-afk <prompt> [--model M] [--out F] [--timeout S] [--system-prompt S] [--session-prefix P]" >&2; exit 2; }

OUT="${OUT:-$(mktemp -t claude-afk.XXXXXX.json)}"
RAW="$(mktemp -t claude-afk-raw.XXXXXX.txt)"
SESSION="${PREFIX}-$$-${RANDOM}"

tmux new-session -d -s "$SESSION" \
  "claude -p ${MODEL:+--model $(printf '%q' "$MODEL")} \
   ${SYS:+--append-system-prompt $(printf '%q' "$SYS")} \
   $(printf '%q' "$PROMPT") > $(printf '%q' "$RAW") 2>&1; \
   jq -n --rawfile r $(printf '%q' "$RAW") --arg rc \$? \
     '{result:(\$r|rtrimstr(\"\n\")), session_id:\"\", exit_reason:(if \$rc==\"0\" then \"stop\" else \"error\" end)}' \
     > $(printf '%q' "$OUT.tmp") && mv $(printf '%q' "$OUT.tmp") $(printf '%q' "$OUT")"

START=$(date +%s%3N)
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ ! -s "$OUT" ]; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$RAW"
    jq -n --argjson d "$(( $(date +%s%3N) - START ))" \
      '{result:"", session_id:"", exit_reason:"timeout", duration_ms:$d}'
    exit 124
  fi
  sleep 1
done

tmux kill-session -t "$SESSION" 2>/dev/null || true
jq --argjson d "$(( $(date +%s%3N) - START ))" '. + {duration_ms:$d}' "$OUT"
rm -f "$RAW" "$OUT"
```

Save as `~/.local/bin/claude-afk`, `chmod +x`. Replace `claude -p --output-format json` calls with `claude-afk`.

## Caller notes

- Hermetic settings only override hooks; permissions/MCP come from `~/.claude/settings.json`. Extend the hermetic settings if you need stricter perms.
- Check `.exit_reason`: `stop` = clean, `timeout` = wrapper killed the session.
- No streaming, no resume, tmux-only. Caller's global MCP config applies.

## Relationship to arc-agents

arc-agents uses the same mechanism (interactive `claude` in tmux, Stop hook for signaling) but dispatches via the ledger rather than blocking on JSON output. claude-afk is for *other* systems — cron jobs, scripts, agents — that speak `claude -p` and want observability of a live tmux pane without re-architecting around a ledger.
