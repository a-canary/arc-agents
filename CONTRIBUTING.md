# Contributing to arc-agents

Thank you for contributing! Here are the guidelines to follow.

## Development Setup

```bash
bun install
bun test        # run all tests
bun run typecheck  # type check without emitting
```

## Submitting Changes

1. **Fork & branch** — work on a feature branch, not `main`
2. **Test first** — add/update tests for every new behavior
3. **Pass the merge gate** — `bin/merge-gate.sh` must green before opening a PR
4. **One concern per PR** — keep diffs small and focused
5. **Describe your change** — the PR description should explain *what* and *why*, not just link a ticket

## Code Style

- TypeScript throughout, Bun runtime
- No `any` typing
- Use named exports over default exports for library code
- Prefer `const` over `let`

## Commit Messages

Format: `<type>(<scope>): <short description>`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `quality`

Examples:
- `feat(ledger): add journal compaction`
- `fix(bookie): reject negative priority`
- `quality(worker): set parent env vars on spawn`

## Ledger Discipline

- Each task = one branch = one PR
- Keep acceptance criteria in the task body
- Chain of evidence before asking for a review

## Reporting Issues

Open a GitHub issue with:
- Clear description of the problem or feature request
- Steps to reproduce (for bugs)
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0.
