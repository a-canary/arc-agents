# arc-agents

Universal agent harness. Ledger-dispatched, interactive-pane runtime.

See `PRD-v1.md` for product spec and `CHOICES.md` for scoped decisions.

## Quickstart

```
bun install
bun bin/ledger.ts init
bun bin/launch.ts
```

## Layout

```
bin/         executable entrypoints (ledger, agent, launch)
src/         library code (ledger, profiles, ke, dispatch)
profiles/    role definitions (developer.json, director.json, admin.json)
skills/      skill definitions (bookie, ke-recall, ke-learn, spawn)
system/      system-level docs (coding-rules, safety, lifecycle)
contexts/    bounded-context glossaries (CONTEXT.md per context)
```

State and ephemeral local data live in `.private/` (gitignored).
Portfolio state lives in `~/vault/` (ledger.db, ke/, agents/).
