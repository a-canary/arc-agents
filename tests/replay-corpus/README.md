# replay-shadow corpus (S-0003)

Seed corpus of 30 retro-captured worker turns. Format conforms to
`skills/replay-shadow/FIXTURE-SCHEMA.md` (`$schema_version: 1`).

Each `<task-id>/` directory holds:

- `fixture.json` — canonical manifest (unit, input, env, transcript, output_diff, quality)
- `session.jsonl` — raw claude session transcript (canonical per CHOICES.md S-0003.c)
- `ledger-seed.json` — task + parent chain + spawned children rows
- `ledger-diff.json` — events emitted by the worker during the turn

`MANIFEST.json` lists every fixture in the corpus with terminal_state +
session source.

## Retro-capture caveats

Fixtures were built post-hoc from the live ledger + on-disk claude sessions,
not from a live `arc-replay capture` run. Consequences:

- `input.rendered_prompt` is `null` — the exact prompt the worker saw is not
  reconstructable from the session JSONL alone. Future capture-time fixtures
  will populate this from `ledger render-prompt`.
- `source.schema_sha` is `"pending-s-0003b-merge"` — replace once PR #36
  (FIXTURE-SCHEMA.md) merges.
- `input.model`, `input.skill_set`, `env.git.repo_sha`, `env.env_vars` are
  best-effort; capture-time runs will fill them.

Sufficient for diff-based regression detection on `transcript.tool_calls`,
`output_diff.ledger_writes`, and `unit.terminal_state` — the load-bearing
signals for promotion gates.

## Regenerate

```
bun bin/seed-replay-corpus.ts --count 30
```

Pulls from `~/vault/ledger.db` + `~/.claude/projects/-home-aaron-repos-arc-agents/`.
