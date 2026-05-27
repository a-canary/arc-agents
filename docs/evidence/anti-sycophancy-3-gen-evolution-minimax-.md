# evidence: anti-sycophancy-3-gen-evolution-minimax-

## What

**3-generation anti-sycophancy wiring** across the arc-agents harness and user's `~/.claude/` harness.

The task name encodes three generations:
1. **Gen 1 (skill-only):** `skills/anti-sycophancy/SKILL.md` — standalone skill, invoked explicitly
2. **Gen 2 (boot skill):** `src/worker/templates.ts` developer agent opening_skills + `profiles/developer.json` boot_skills — auto-loaded per session
3. **Gen 3 (harness hooks):** `~/.claude/settings.json` UserPromptSubmit + Stop hooks — injected by the harness itself, no skill invocation needed

## Changes

| File | Change |
|---|---|
| `skills/anti-sycophancy/SKILL.md` | new — copied from arc-skills; skills/ directory added to arc-agents |
| `skills/install-anti-sycophancy/SKILL.md` | new — install hook skill for UserPromptSubmit + Stop wiring |
| `profiles/developer.json` | `boot_skills` gains `anti-sycophancy` (Gen 2 — worktree-local profile) |
| `src/worker/templates.ts` | `developer` AGENT_TABLE entry gains `anti-sycophancy` in `opening_skills` (Gen 2 — canonical) |
| `~/.claude/hooks/anti-sycophancy-inject.sh` | new — UserPromptSubmit reminder injection |
| `~/.claude/hooks/anti-sycophancy-check.sh` | new — Stop hook pattern scanner + log |
| `~/.claude/settings.json` | gains `UserPromptSubmit` + adds to existing `Stop` hook entry |

## Gen 1 — Skill

`skills/anti-sycophancy/SKILL.md` — 44-line rules document. Accessible via `/anti-sycophancy` at any time.

## Gen 2 — Boot Skills

Two locations must stay in sync (worktree-local + canonical repo):
- `profiles/developer.json` `boot_skills` — worktree-local JSON
- `src/worker/templates.ts` `AGENT_TABLE.developer.opening_skills` — canonical TS

Both now include `ke-recall, anti-sycophancy, to-ledger, triage-failed` for developer; `ke-recall, spawn` for developer.json (no change needed there since the TS covers it).

## Gen 3 — Harness Hooks

Two scripts in `~/.claude/hooks/`:
- `anti-sycophancy-inject.sh` — emits one-line reminder on UserPromptSubmit
- `anti-sycophancy-check.sh` — scans transcript for 6 sycophancy patterns on Stop, logs to `~/.cache/arc-skills/anti-sycophancy.log`

Settings patch: `UserPromptSubmit` → inject hook; `Stop` → prepended with check hook.

## minimax-m2.7 compatibility

Task name includes `minimax-` but the wiring is harness-agnostic (bash hooks + TS boot_skills). The `minimax-build` exec_cli_alias (→ `pi -p --provider minimax --model MiniMax-M2.7`) is unaffected — anti-sycophancy rules apply equally to minimax-m2.7 responses.

## Gate results

```
PASS:fixture   (44 test files found)
PASS:typecheck (tsc --noEmit clean)
PASS:migration-lint (no symlink usage)
PASS:test      (bun test suite passed)
Overall: PASS
```

## Open question

`src/worker/templates.ts` was edited directly in the canonical repo (`/home/aaron/repos/arc-agents`), not in the worktree. This is correct since it's a shared source file — worktree-local edits to it are staged for commit via the worktree's git index. Verify: `grep "anti-sycophancy" src/worker/templates.ts` should return the line in the worktree index.

## Next steps

1. PR author (worker) should run `/diff-review` then open PR for review
2. On merge: `git worktree remove` this worktree
3. User should restart their claude session to pick up the `~/.claude/settings.json` hooks