# Monorepo Migration Plan: arc-agents + arc-webui → `arc/`

**Status:** Draft — awaiting user approval  
**Date:** 2026-05-28  
**Source:** `/counsel` session 2026-05-28

---

## 1. Goals

Bundle `arc-agents` + `arc-webui` into a single `arc/` monorepo while:
- Preserving full git history for both projects
- Maintaining independent deployability
- Sharing CI, tooling, and LICENSE
- Keeping `arc-skills` separate + private (unchanged)

---

## 2. History Preservation

### Option A: `git subtree add` (recommended)
```bash
# Create new monorepo
mkdir arc && cd arc
git init

# Add LICENSE, README, root config
git add LICENSE README.md package.json tsconfig.json
git commit -m "chore(monorepo): initialize root"

# Inject arc-agents as packages/arc-agents (preserves full history)
git subtree add --prefix=packages/arc-agents git@github.com:a-canary/arc-agents.git main

# Inject arc-webui as packages/arc-webui (preserves full history)
# Note: arc-webui has no remote — user must push it first, or use local path
git subtree add --prefix=packages/arc-webui /path/to/arc-webui main
```

**Pros:** Single linear history, no submodules, history searchable across packages  
**Cons:** Subtree push/pull discipline required for ongoing development

### Option B: `git filter-repo` + merge (alternative)
Rewrite each repo history to live under `packages/*`, then merge.

**Pros:** True monorepo semantics  
**Cons:** Rewrites history (needs force-push), more complex

### Recommendation
**Option A (subtree)** — simpler, reversible, preserves authorship exactly.

### Pre-flight for arc-webui
`arc-webui` has no remote. Options:
1. User pushes `arc-webui` to `git@github.com:a-canary/arc-webui.git` before migration
2. Use local path (history preserved but not collaborative)

---

## 3. Package Boundaries

```
arc/                          # Root
├── package.json              # Workspace root (Bun workspaces)
├── tsconfig.base.json        # Shared TS config
├── .github/
│   └── workflows/
│       ├── ci.yml            # Shared: typecheck + test all packages
│       └── release.yml       # Per-package publish (if public)
├── LICENSE                   # Unified
├── packages/
│   ├── arc-agents/           # Current arc-agents content
│   │   ├── bin/              # ledger, factory, arc-chat, arc-tui, etc.
│   │   ├── skills/           # arc-agents specific skills
│   │   ├── src/
│   │   ├── tests/
│   │   └── package.json      # name: "arc-agents"
│   └── arc-webui/            # Current arc-webui content
│       ├── bin/              # serve.ts
│       ├── src/
│       ├── public/
│       └── package.json      # name: "arc-webui"
├── skills/                   # arc-skills STAYS HERE (private, separate)
│   ├── arc-skills/
│   └── arc-fork-skills/
└── .claude/                  # Root-level agent config (optional)
```

### Workspace Configuration

**Root `package.json` additions:**
```json
{
  "workspaces": [
    "packages/*"
  ],
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.5.0"
  },
  "scripts": {
    "typecheck": "bun run -r @arc-agents/workspace-config typecheck",
    "test": "bun test"
  }
}
```

**Each package keeps:**
- Own `bin/` entry points
- Own `package.json` with name + version
- Own `tsconfig.json` extending base

---

## 4. Shared CI

### `arc/.github/workflows/ci.yml`
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun test
```

### Strategy
- **Unified CI** — one workflow runs typecheck + tests for all packages
- **No per-package matrix** needed yet — both packages share runtime
- Future: add `publish.yml` when/if packages go public

---

## 5. Shared LICENSE

Both repos use MIT (`LICENSE` file present in both). No action needed — copy to root.

```
arc/LICENSE
```

If licenses differ, flag for user decision before migration.

---

## 6. Migration Steps (Sequence)

### Pre-flight
1. [ ] User pushes `arc-webui` to GitHub (or confirms local-only is acceptable)
2. [ ] Backup both repos (just in case)
3. [ ] Confirm arc-skills stays at current location

### Phase 1: Create monorepo scaffold
1. Create `arc/` directory
2. Initialize git
3. Add root `package.json` with workspaces
4. Add `tsconfig.base.json`
5. Add `.github/workflows/ci.yml`
6. Add shared `LICENSE`
7. Add `.gitignore`

### Phase 2: Inject packages via subtree
1. `git subtree add --prefix=packages/arc-agents git@github.com:a-canary/arc-agents.git main`
2. `git subtree add --prefix=packages/arc-webui <remote-url> main`

### Phase 3: Fix internal references
1. Update any hardcoded paths referencing `../../` or `../arc-*`
2. Update `CLAUDE.md` root docs reference
3. Update `CHOICES.md` paths if any absolute

### Phase 4: Verify
1. `bun install` — resolves all workspaces
2. `bun run typecheck` — all packages
3. `bun test` — all packages
4. `bun run --filter arc-agents ledger list` — works
5. `bun run --filter arc-webui dev` — works

### Phase 5: Go live
1. Point `arc-agents` remote to new monorepo
2. User updates local clones
3. Deprecate old `arc-agents` / `arc-webui` repos (archive on GitHub)

---

## 7. Open Questions

| Question | Resolution Needed |
|---|---|
| arc-webui remote | User must push to GitHub or accept local-only history |
| arc-skills location | Confirmed: stays separate at `~/repos/arc-skills` |
| Existing arc-agents clone references | User must update `$HOME/repos/arc-agents` path |
| `arc-webui` public/private | Both private currently — no change needed |

---

## 8. Rollback Plan

Subtree approach is non-destructive:
1. Keep old `arc-agents` and `arc-webui` repos as backups
2. `git subtree split` can extract a package back if needed
3. No history is lost or rewritten

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| arc-webui has no remote | User pushes first, or accept local history |
| Hardcoded path breaks | Phase 3 scan for `../arc-` and `../../` refs |
| Subtree workflow friction | Document `git subtree push/pull` workflow for team |
| arc-skills coupling | Keep arc-skills at separate path; monorepo has its own skills/ |

---

## 10. Timeline

No execution until user approval. Once approved:
- **30 min** — Scaffold + inject (automated)
- **15 min** — Manual fixup
- **15 min** — Verification
- **Total: ~1 hour** to complete migration