#!/bin/bash
# PreToolUse:Bash hook — soft-block a `git commit` that does NOT pin the author
# identity with per-commit `-c user.name=… -c user.email=…` flags.
#
# Why: ~/.claude/CLAUDE.md already carries the prose rule ("Commit with the
# identity in ~/vault/USER.md, never a tool default. Set `-c user.name -c
# user.email` per-commit; don't trust global config.") Yet the journal logs the
# exact failure repeatedly: on 2026-06-23 alone, session 284dade2 made THREE
# commits (9aa9c9e, 4af2f01, dd5ea24) on the PUBLIC arc-skills repo with the
# wrong email `noreply@a-canary.dev` instead of `a-canary@users.noreply.github.com`,
# because it trusted ambient global/local git config instead of per-commit flags.
# Fixing those needs `amend --reset-author` + force-push on public history.
# A prose rule the offenders drive straight through doesn't hold; its sibling
# bash-dump-guard.sh and reread-guard.sh ARE enforced at the tool boundary.
# This closes the identity half at the same boundary.
#
# Fires ONLY on the precise shape:
#   - tool is Bash
#   - the command invokes `git commit` (excluding amend/fixup/squash/revert/merge)
#   - AND the command does NOT carry BOTH `-c user.name=` and `-c user.email=`
# Then exit 2 (soft block): stderr is fed back to Claude, which re-runs the
# commit with the identity flags from ~/vault/USER.md.
#
# Escape hatch: COMMIT_IDENTITY_GUARD=off in the environment disables it; prepend
# it to the one command you genuinely need to commit with ambient config.
# Reversible: delete this file + its settings.json PreToolUse:Bash block.

set -uo pipefail

[ "${COMMIT_IDENTITY_GUARD:-on}" = "off" ] && exit 0

payload="$(cat)"

command -v jq >/dev/null 2>&1 || exit 0

tool="$(echo "$payload" | jq -r '.tool_name // empty')"
[ "$tool" = "Bash" ] || exit 0

cmd="$(echo "$payload" | jq -r '.tool_input.command // empty')"
[ -n "$cmd" ] || exit 0

# --- strip non-executing text before any detection (ticket: substring-match bug) ---
# The guard used to scan the raw command, so GITCOMMIT appearing as PROSE inside a
# heredoc body or a quoted literal tripped it — blocking writes that invoke no git at
# all, including the filing of the ticket for this very bug. Only executable text is
# scanned now. ponytail: line-based heredoc strip + quote strip, not a real shell
# parser; upgrade to a shared parsing helper if a third gate needs the same logic.
strip_noise() {
  awk '
    # Drop heredoc bodies: after <<EOF / <<-EOF / <<"EOF" / <<'"'"'EOF'"'"', skip to the
    # terminator line. The opener line itself stays (it can hold a real command).
    !inhd && match($0, /<<-?[[:space:]]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/) {
      tag = substr($0, RSTART, RLENGTH)
      gsub(/^<<-?[[:space:]]*|["'"'"']/, "", tag)
      inhd = 1; print; next
    }
    inhd {
      line = $0; sub(/^[[:space:]]*/, "", line)
      if (line == tag) inhd = 0
      next
    }
    { print }
  ' <<<"$1" |
  # Drop quoted literal contents; keep the delimiters so word boundaries survive.
  sed -e "s/'[^']*'/''/g" -e 's/"[^"]*"/""/g'
}

scan="$(strip_noise "$cmd")"

case "$scan" in
  *COMMIT_IDENTITY_GUARD=off*) exit 0 ;;
esac

# Only gate actual commit invocations.
# Command position: start of line, or after a shell operator (| ; && || ( newline).
# `git` must be the invoked word and `commit` a bare argument of it.
if ! grep -qE '(^|[;&|(]|^[[:space:]]*)[[:space:]]*(env[[:space:]]+[^;&|]*)?git\b[^;&|]*[[:space:]]commit([[:space:]]|$)' <<<"$scan"; then
  exit 0
fi

# Skip amend/fixup/squash/reuse continuations — different identity semantics.
if echo "$scan" | grep -qE 'git\b[^|;&]*\bcommit\b[^|;&]*(--amend|--fixup|--squash|-C[[:space:]]|--reuse-message|--no-edit)'; then
  exit 0
fi
case "$scan" in
  *"git merge"*|*"git revert"*|*"git cherry-pick"*) exit 0 ;;
esac

# Require BOTH identity flags pinned per-commit, anywhere in the command.
has_name="$(echo "$scan" | grep -cE '(^|[[:space:]])-c[[:space:]]+user\.name=')"
has_email="$(echo "$scan" | grep -cE '(^|[[:space:]])-c[[:space:]]+user\.email=')"

if [ "$has_name" -ge 1 ] && [ "$has_email" -ge 1 ]; then
  exit 0
fi

{
  echo "COMMIT_IDENTITY_GUARD: this 'git commit' does not pin the author identity per-commit (CLAUDE.md: 'Set -c user.name -c user.email per-commit; don't trust global config')."
  echo "Repeated journal failure: commits landed on a PUBLIC repo with the wrong email because ambient git config was trusted; fixing needs amend --reset-author + force-push."
  echo "Re-run with the identity from ~/vault/USER.md, e.g.:"
  echo "  git -c user.name='a-canary' -c user.email='a-canary@users.noreply.github.com' commit -m '...'"
  echo "(Read ~/vault/USER.md if unsure of the current identity.)"
  echo "If you genuinely must use ambient config, prepend COMMIT_IDENTITY_GUARD=off to this one command."
} >&2
exit 2
