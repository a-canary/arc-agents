# arc-agents

Universal agent harness. Ledger-dispatched, interactive-pane runtime.

See `PRD-v1.md` for product spec and `CHOICES.md` for scoped decisions.

## Quickstart

```
bun install
bun bin/ledger.ts init
bun bin/launch.ts
```

## Install bins on PATH

```
# from repo root:
bun install
bun link            # registers package
bun link arc-agents # installs ledger, arc-launch, wait-for-ledger into ~/.bun/bin (or ~/.local/bin if symlinked)

# verify
ledger --help
which ledger        # → /home/<you>/.bun/bin/ledger
```

If a stale `director` binary from the old pi install exists, remove it:

```
rm -f ~/.local/bin/director ~/.local/bin/agent
```

Uninstall:

```
bun unlink arc-agents
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
