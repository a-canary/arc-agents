# Evidence: [conjecture] Public examples runnable

## What was done

Added `examples/` directory with 3 runnable shell scripts. All work from a clean
clone with only `bun` installed. No private paths, no proprietary keys.

### examples/01-ledger-quickstart/run.sh

End-to-end: `bun install` → `init` → `create` → `list` → `show` →
`tick` → `doctor`.

Uses `node` to parse JSON (safe: node ships with bun, avoids python3 external dep).

Verified clean run 2026-05-28 — all 6 steps produced expected JSON, exit 0.

### examples/02-chat-interview/run.sh

Posts a message via `arc-chat.ts post`, streams replies with `tail`, shows
recent issues. Header documents the factory prerequisite (run `bun bin/factory.ts`
in a separate terminal first).

Uses `node` for JSON parsing.

### examples/03-factory-health/run.sh

Ledger doctor + state summary. Pure read, no side effects. Verifies arc-agents
health without spinning up workers.

### README.md

Added `## Examples` section documenting each script with `bash` invocation,
prerequisite note for example 02 (requires factory), and clean-clone guarantee.

## Verification

```
bash examples/01-ledger-quickstart/run.sh  → exit 0
bash examples/02-chat-interview/run.sh     → exit 0
bash examples/03-factory-health/run.sh     → exit 0
bun run typecheck                          → clean
```

Check for private paths: none found in `examples/`.
Check for secrets: none found in `examples/`.

## diff-review notes (first pass)

Reviewer flagged that example 02 requires arc-factory (not installed by `bun
install` alone). Fixed: README now documents this prerequisite explicitly;
example 02 script header also notes it. Examples 01 and 03 are bun-only.
