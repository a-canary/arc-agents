# Contributing

## Setup

```bash
git clone <repo>
cd arc-agents
bun install
bun test              # run all tests
bun run typecheck     # typecheck only
```

## Filing Issues

Open an issue on GitHub. Solo dev — triage may be slow. Expect a reply within a week.

## Submitting PRs

1. Fork the repo.
2. Create a branch: `git checkout -b worker/<slug>`.
3. Make your change. Run `bun test` + `bun run typecheck` locally.
4. Open a PR against `main`. Link the issue it addresses.
5. Triage is async — be patient. Feel free to ping after 7 days.

## Dev Environment

- **Runtime:** Bun (not Node)
- **Ledger:** SQLite at `~/vault/ledger.db`
- **Worktrees:** `~/worktrees/<repo>-<slug>/`
- **Key scripts:** `bin/merge-gate.sh` (CI gate), `bin/ledger.ts` (CLI)

Run the full merge gate before submitting:

```bash
bin/merge-gate.sh
```

## Questions?

Open an issue. Don't file a PR without checking in first.