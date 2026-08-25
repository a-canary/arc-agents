# arc-agents — Public Examples

These examples run from a clean clone of `arc-agents` with zero API keys.

## Prerequisites

### Required
- **Bun** — runtime (`curl -fsSL https://bun.sh/install | bash`)

### Optional
- **Docker** — needed only if you want to start a ledger DB in a container for the migration demo

The KE (knowledge engine) search example needs no external services — ke indexes `~/vault/ke/` with sqlite-vec over local all-MiniLM-L6-v2 embeddings.

## Quick start

```bash
cd ~/repos/arc-agents
bun install

# Run all examples
./examples/run-all.sh

# Or individually:
./examples/smoke.sh       # verify project structure + skills
./examples/ledger.sh      # ledger CLI demo (create, list, show)
./examples/commands.sh    # all CLI verbs + notes on what each does
```

## What each example does

### `smoke.sh` — Project structure check
Verifies:
- All 9 skills present (`skills/*/SKILL.md`)
- Core lib files (`src/ledger/db.ts`, `claim.ts`, etc.)
- CLI bins parse without error (`ledger.ts init`, `ledger.ts list`)
- Test suite passes (`bun test`, `bun run typecheck`)

### `ledger.sh` — Ledger CLI demo
Walks through ledger workflow using a temporary test DB:
1. Initialize fresh ledger (`ledger init`)
2. Create a sample issue (`ledger create --title ... --kind task`)
3. List all issues
4. Show the created issue
5. Clean up

No production data touched.

### `commands.sh` — CLI verb reference
Iterates every `ledger` verb, shows its flags, and notes side effects.

## KE (knowledge engine) integration

`arc-agents` ships with `ke-learn` and `ke-recall` skills that delegate to a
separate `ke` installation at `~/repos/ke`. Those skills are present in
`skills/ke-learn/` and `skills/ke-recall/`. To use them:

```bash
# Install ke (separate repo)
git clone git@github.com:a-canary/ke.git ~/repos/ke
cd ~/repos/ke && bun install

# Use arc-agents skills
cd ~/repos/arc-agents
bun bin/ledger.ts create --title "my task" --kind task --type quality
# → ke-recall runs automatically at session start
# → ke-learn runs automatically at session stop
```

## Secrets / private paths

All examples use no secrets. The ledger demo uses an isolated temp DB.
