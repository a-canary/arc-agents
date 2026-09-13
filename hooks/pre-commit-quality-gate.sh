#!/bin/bash
# PreToolUse hook — gate `git commit` on a clearly demonstrated single-axis improvement.
# Axes: quality, security, scale, efficiency, hygiene.
# Reads PreToolUse JSON on stdin; exit 2 + stderr blocks the call and feeds the message back to Claude.

set -uo pipefail

LOG=/home/aaron/.claude/hooks/pre-commit-quality-gate.log
# ponytail: no temperature/seed pin -- `claude -p` exposes neither flag, so the
# "temp 0" fix direction is unavailable. Determinism is instead bought by
# removing the loop's DRIVER: the judge used to be told to suggest "chore:"/
# "style:" and also that those are not axes, so it blocked its own suggestion on
# the next turn and cycled forever. The prompt now constrains suggestions to the
# five real axes. If verdicts still flap on identical input, the next rung is
# best-of-3 consensus on the verdict line -- not added now, no measurement says
# it is needed.
JUDGE_MODEL="${COMMIT_GATE_MODEL:-claude-haiku-4-5-20251001}"
JUDGE_TIMEOUT="${COMMIT_GATE_TIMEOUT:-45}"
MAX_DIFF_BYTES="${COMMIT_GATE_MAX_DIFF:-60000}"

payload="$(cat)"
tool="$(echo "$payload" | jq -r '.tool_name // empty')"
cmd="$(echo "$payload"  | jq -r '.tool_input.command // empty')"

[ "$tool" = "Bash" ] || exit 0

# Only gate actual commit invocations.
case "$cmd" in
  *"git commit"*|*"git -c "*"commit"*) : ;;
  *) exit 0 ;;
esac

# Skip merge/revert/amend/fixup commits — those have other purposes.
echo "$cmd" | grep -qE -- '--amend|--fixup|--squash|--allow-empty|-i\b|--interactive|git revert|git merge' && exit 0

# Bypass escape hatch.
echo "$cmd" | grep -qE 'COMMIT_GATE=skip' && {
  echo "[$(date -Iseconds)] BYPASS via COMMIT_GATE=skip :: ${cmd:0:160}" >> "$LOG"
  exit 0
}

# Extract -m / --message value (single- or double-quoted, or bare token).
# Slurp the whole command with perl (-0777) so a quoted message body spans
# newlines: multi-paragraph messages with a Co-Authored-By trailer are the norm,
# and a line-oriented grep would truncate them to the first line (read as "empty").
msg="$(printf '%s' "$cmd" | perl -0777 -ne 'my $q=chr(39); if(/(?:-m|--message)[= ]$q([^$q]*)$q/s){print $1}elsif(/(?:-m|--message)[= ]"([^"]*)"/s){print $1}elsif(/(?:-m|--message)[= ](\S+)/){print $1}')"

# Fallback: `-m`/`--message` not used. The message may be supplied via
# `-F <file>` / `--file <file>` (a valid, common form for multi-paragraph
# bodies). Without this branch the gate sees an empty message and BLOCKs a
# perfectly good commit as "no commit message", forcing an awkward single-`-m`
# rewrite and burning turns. Read the named file so the judge sees the real
# message. `-F -` is handled too: the heredoc body is part of the command
# string, so it is parsed out below rather than treated as an empty message.
if [ -z "$msg" ]; then
  msg_file="$(printf '%s' "$cmd" | perl -0777 -ne 'my $q=chr(39); if(/(?:-F|--file)[= ]$q([^$q]+)$q/s){print $1}elsif(/(?:-F|--file)[= ]"([^"]+)"/s){print $1}elsif(/(?:-F|--file)[= ](\S+)/){print $1}')"
  # `-F -` reads the body from a heredoc. The heredoc text IS present in the
  # command string the hook receives, so it is observable after all: pull the
  # body out of `<<[-]DELIM ... DELIM`. Without this the gate saw an empty
  # message and BLOCKed with "no commit message provided" — a dead end, since
  # -F - is the only clean way to pass a multi-paragraph body.
  if [ "$msg_file" = "-" ]; then
    msg="$(printf '%s' "$cmd" | perl -0777 -ne '
      if (/<<-?\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|'"'"'([A-Za-z_][A-Za-z0-9_]*)'"'"'|([A-Za-z_][A-Za-z0-9_]*))\r?\n(.*?)\n[ \t]*(?:\1|\2|\3)\b/s) {
        print $4;
      }')"
  fi
  if [ -n "$msg_file" ] && [ "$msg_file" != "-" ]; then
    # Resolve relative -F paths against a leading `cd <dir>` like the diff block does.
    f_dir="$(echo "$cmd" | grep -oP '^\s*cd\s+\K(?:"[^"]*"|'"'"'[^'"'"']*'"'"'|\S+)' | head -1 | sed -E "s/^['\"]//; s/['\"]$//")"
    if [ -f "$msg_file" ]; then
      msg="$(cat "$msg_file" 2>/dev/null)"
    elif [ -n "$f_dir" ] && [ -f "$f_dir/$msg_file" ]; then
      msg="$(cat "$f_dir/$msg_file" 2>/dev/null)"
    fi
  fi
fi

# Gate the diff of the repo the commit actually targets, not the hook's inherited
# cwd. The Bash tool resets cwd between calls, so a `cd <dir> && git commit` would
# otherwise be judged against an unrelated working tree. Honor a leading `cd` in
# the command; fall back to the inherited cwd.
commit_dir="$(echo "$cmd" | grep -oP '^\s*cd\s+\K(?:"[^"]*"|'"'"'[^'"'"']*'"'"'|\S+)' | head -1 | sed -E "s/^['\"]//; s/['\"]$//")"
# Honor an explicit `git -C <dir>` on the commit too — it pins the repo just
# like a leading `cd`, and is the safer form precisely because it does not rely
# on the harness-managed cwd (which resets between Bash calls and has caused the
# gate to judge a sibling worktree's diff — a false-positive block).
if [ -z "$commit_dir" ]; then
  commit_dir="$(echo "$cmd" | grep -oP 'git\s+-C\s+\K(?:"[^"]*"|'"'"'[^'"'"']*'"'"'|\S+)' | head -1 | sed -E "s/^['\"]//; s/['\"]$//")"
fi
# Resolve the repo toplevel so the verdict is attributable to a known repo path
# even when neither `cd` nor `-C` is present (bare `git commit` on inherited cwd).
repo_top="$( { [ -n "$commit_dir" ] && cd "$commit_dir"; git rev-parse --show-toplevel; } 2>/dev/null)"
diff="$( { [ -n "$commit_dir" ] && cd "$commit_dir"; git diff --cached; } 2>/dev/null)"
[ -z "$diff" ] && exit 0

if [ "${#diff}" -gt "$MAX_DIFF_BYTES" ]; then
  diff="$(printf '%s' "$diff" | head -c "$MAX_DIFF_BYTES")
... [diff truncated at $MAX_DIFF_BYTES bytes for judge]"
fi

read -r -d '' JUDGE_PROMPT <<'PROMPT' || true
You are a strict pre-commit quality gate. A commit may proceed ONLY if it clearly demonstrates a SINGLE improvement along exactly ONE of these axes:
  - quality     (correctness, clarity, removing bugs, simpler structure)
  - security    (closing a vulnerability, reducing attack surface, hardening)
  - scale       (handling more load, more data, more concurrency)
  - efficiency  (less CPU, less memory, less IO, less cost, fewer round-trips)
  - hygiene     (deleting dead code/docs/config, removing stale or unreferenced
                 files, pruning retired artifacts -- a net-negative diff whose
                 win is that the thing is gone)

A pure-deletion diff IS a valid commit. Its axis is `hygiene` whenever removal
is the point; do not demand that a deletion ALSO fix a bug or improve
performance before it may land. "Just a deletion, no bug fix" is NOT a reason to
BLOCK -- that is the definition of hygiene. Reserve `quality` for deletions that
change program behaviour (e.g. ripping out a broken code path).

You will receive a commit message and the staged diff. Decide:
  1. Does the commit message name (explicitly or unambiguously) exactly one of the five axes?
  2. Does the diff substantively realize that improvement (not just rename, reformat, comment, or restructure without an axis win)?
  3. Is the commit focused on that single axis, not a grab-bag of unrelated edits?
  4. Is the commit message complete and well-formed -- not cut off mid-sentence, not
     ending on a dangling word/connective (e.g. "...not any", "...the real cause of the 403, not")?
     A truncated or incomplete body is a BLOCK even when the title's axis is clear.

Judge the diff against the scope the COMMIT MESSAGE claims -- not against an
implicit demand that every referenced file appear inside this diff window:
  - A wiring/integration commit that states a dependency "already landed in
    <prior commit/slice>" is NOT incomplete for lacking that file. Judge whether
    THIS diff substantively wires/uses it; never BLOCK as "feature code missing"
    when the message says the code landed earlier.
  - An honestly-disclosed intentional gap (e.g. "specs RED by design", "wiring
    only", "stub for <N>") is transparent scoping, not a broken promise. Do not
    BLOCK it as incomplete when message and diff openly document the gap.
  - If the diff is marked truncated, judge ONLY the visible content; never infer,
    list, or claim files/changes from the unshown portion.

If ALL FOUR checks are yes -> respond with exactly:
PASS: <axis> - <one-sentence reason citing the concrete change>

Otherwise -> respond with exactly:
BLOCK: <one short reason> | suggested message: <axis>: <imperative summary>

Rules for the BLOCK line (follow exactly):
  - The <short reason> must name WHICH check failed and how. Do not say "axis is
    undefined/missing" when the message DID name an axis -- if an axis is named
    but the diff realizes a different one, say "message claims <named> but diff
    realizes <actual>"; if named but not substantive, say "<named> not
    substantive: diff only <rename/reformat/comment/config-enforcement>".
  - The suggested-message <axis> MUST be the axis the DIFF actually realizes, not
    the one the message claimed. Read the diff to decide (e.g. a diff that
    prevents secret/key leaks or hardens deploy is security, never quality;
    pure formatting/lint-enforcement with no correctness change is not a quality
    win; a diff that only deletes stale/unreferenced files is hygiene, never
    quality).
  - The suggested <axis> MUST be one of the five axes above, verbatim and
    lowercase: quality, security, scale, efficiency, hygiene. NEVER suggest a
    prefix you would reject on the next turn -- do not emit "chore:", "style:",
    "docs:", "refactor:", or any other prefix outside the five. Suggesting a
    prefix that is not an axis is itself a format violation.
  - The suggested message MUST be single-axis: describe ONE activity only. Never
    list two axes or two activities joined by "and"/"+". If the diff genuinely
    mixes axes, the reason is "mixes N axes" and the suggested message names the
    single dominant one plus "; split the rest into separate commits".

Reply with the ONE PASS/BLOCK line and NOTHING ELSE -- no preamble, no
explanation paragraph, no trailing notes. Any extra prose is a format violation
that breaks the automated parser downstream.
PROMPT

INPUT=$(cat <<EOF
COMMIT MESSAGE:
${msg:-(none provided in -m; gate requires one)}

STAGED DIFF:
$diff
EOF
)

verdict="$(printf '%s\n\n---\n\n%s\n' "$JUDGE_PROMPT" "$INPUT" \
  | timeout "$JUDGE_TIMEOUT" claude -p --model "$JUDGE_MODEL" 2>>"$LOG")"
rc=$?

ts="$(date -Iseconds)"
if [ $rc -ne 0 ] || [ -z "$verdict" ]; then
  echo "[$ts] JUDGE_ERROR rc=$rc cmd=${cmd:0:160}" >> "$LOG"
  # Fail-open: don't block on judge infra failure. Surface to user via log.
  exit 0
fi

verdict_line="$(echo "$verdict" | grep -E '^(PASS|BLOCK):' | head -1)"
echo "[$ts] ${verdict_line:-RAW:$verdict} :: repo=${repo_top:-<inherited-cwd>} :: ${cmd:0:160}" >> "$LOG"

if [[ "$verdict_line" == PASS:* ]]; then
  exit 0
fi

cat >&2 <<EOF
COMMIT_GATE_BLOCKED

The pre-commit quality gate rejected this commit. A commit must clearly demonstrate a single improvement in quality, security, scale, efficiency, or hygiene.

Judge verdict:
  ${verdict_line:-$verdict}

Options:
  1. Revise the commit so the diff + message demonstrate one clear axis win.
  2. Split the diff into focused commits, one axis per commit.
  3. Exception (merge resolution, urgent rollback, scratch branch): prefix the bash command with COMMIT_GATE=skip and re-run.
EOF
exit 2
