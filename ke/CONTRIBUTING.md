# Contributing to KE Skills

**Status: personal project, pre-alpha.** Issues and PRs may be triaged slowly — solo dev.

## Setup

```bash
bun install
bun test                            # run all tests
bun test -t "ke"                    # KE skill tests only
bun run typecheck
```

## How KE works

- `ke-recall` — FTS5 search over `~/vault/ke/` (BM25 ranked excerpts)
- `ke-learn` — write one file per insight to `~/vault/ke/<scope>/`

CLI: `bun ~/repos/arc-agents/bin/ke.ts <command>`

## Filing an issue

- Check `~/vault/ke/` for prior discussion before filing
- Label: `ke` for skill bugs, `ke:design` for architecture questions
- Solo dev triages weekly; low-priority items may sit longer

## Pull requests

- One skill improvement or KE workflow change per PR
- Tests required for behavior changes
- See [CONTEXT.md](./CONTEXT.md) for domain glossary
- See [skills/ke-recall/SKILL.md](./skills/ke-recall/SKILL.md) and [skills/ke-learn/SKILL.md](./skills/ke-learn/SKILL.md) for skill conventions