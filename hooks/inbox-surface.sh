#!/usr/bin/env bash
# inbox-surface.sh — PreToolUse hook.
#
# If PWD is inside an agent workspace (~/vault/agents/<agent>/...), scan inbox/*.md for
# files newer than the "last surfaced" marker and inject a summary into the next tool call
# via hookSpecificOutput.additionalContext. Dedup via marker mtime so the same messages
# aren't surfaced on every tool call.
#
# Silent (returns {}) when:
#   - PWD is not under ~/vault/agents/
#   - inbox/ doesn't exist
#   - no new files since the marker
set -euo pipefail

# Discard stdin (hook payload) — we derive context from PWD, not the payload.
cat >/dev/null 2>&1 || true

agents_root="$HOME/vault/agents"
case "$PWD" in
  "$agents_root"/*)
    rel="${PWD#"$agents_root"/}"
    agent_name="${rel%%/*}"
    root="$agents_root/$agent_name"
    ;;
  *) echo '{}'; exit 0 ;;
esac

inbox="$root/inbox"
[[ -d "$inbox" ]] || { echo '{}'; exit 0; }

marker="$root/.inbox-surfaced-at"

shopt -s nullglob
files=( "$inbox"/*.md )
[[ ${#files[@]} -gt 0 ]] || { echo '{}'; exit 0; }

new=()
if [[ -f "$marker" ]]; then
  for f in "${files[@]}"; do
    [[ "$f" -nt "$marker" ]] && new+=( "$f" )
  done
else
  new=( "${files[@]}" )
fi
[[ ${#new[@]} -gt 0 ]] || { echo '{}'; exit 0; }

listing=""
for f in "${new[@]}"; do
  base=$(basename "$f")
  title=$(awk 'NR<30 && /^# / {sub(/^# /, ""); print; exit}' "$f" 2>/dev/null || true)
  listing+="  - inbox/$base"
  [[ -n "$title" ]] && listing+=" — $title"
  listing+=$'\n'
done

touch "$marker"

ctx="New inbox messages in ${agent_name}/inbox/ (unseen since last surface):
${listing}
Read each and either act now, or \`mv\` it to inbox/defer/ with a sibling <slug>-reason.md note explaining why you're deferring."

jq -n --arg c "$ctx" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $c}}'
