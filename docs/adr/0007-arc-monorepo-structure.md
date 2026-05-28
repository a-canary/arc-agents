# ADR 0007 — Arc Monorepo Structure

**Status:** Accepted — 2026-05-28
**Supersedes:** none (new decision)
**Parent:** `arc-framework-arc-monorepo-generic-vault` (vault path flexibility)

## Context

`arc-framework-arc-monorepo-generic-vault` merged — vault/workspace paths are now configurable via env vars (`ARC_VAULT`, `ARC_HOME`, etc.), making the monorepo layout itself a separate decision.

Before any migration can proceed, three questions must be answered:

1. Where does the monorepo live?
2. What is the directory shape?
3. Does this affect arc-webui migration too?

## Decision

### Location

`~/repos/arc/` — new bare repo, not yet initialized. User creates it via:

```bash
mkdir -p ~/repos/arc
cd ~/repos/arc
git init --initial-branch=main
git commit --allow-empty -m "chore: bootstrap arc monorepo"
```

Rationale:
- `A-0005` requires `arc-` prefix. `arc/` is the canonical monorepo home.
- `~/repos/` already holds all project repos; natural grouping.
- `~` is where user owns everything — no permission issues, no external hosting friction.

Not `~/arc/`, not `~/.arc/`, not an external GitHub org. Purely local to start. Remote hosting is a separate decision.

### Shape

```
arc/                          # monorepo root
  packages/
    arc-agents/               # subtree-import from ~/repos/arc-agents
    arc-webui/                # subtree-import from ~/repos/arc-webui
    arc-skills/               # future: subtree-import from ~/repos/arc-skills
    arc-tui/                  # future: new package
    arc-discord/              # future: new package
  system/                     # shared config, schema, tooling (evolved from arc-agents/system/)
  README.md
```

Rationale:
- Single `packages/` dir is simplest — no nested groups needed for ≤6 packages.
- Package names already carry their domain (`arc-agents`, `arc-webui`).
- `system/` at monorepo root (not inside a package) because it's shared infrastructure consumed by **all** packages — the schema, config, and tooling that each package imports. Analogous to `babel.config.js` at repo root or `tsconfig.base.json` in a pnpm workspace. Not arc-agents-specific; evolves into `arc/system/` as the monorepo grows.
- Flat is better than nested until nesting earns its complexity.

### Migration strategy

Subtree-import (not subtree-merge, not git submodule, not bare copy):

```bash
cd ~/repos/arc
git subtree add --prefix=packages/arc-agents ~/repos/arc-agents main
git subtree add --prefix=packages/arc-webui ~/repos/arc-webui main
```

Rationale:
- Preserves full commit history.
- No separate git operations for the submodule.
- Subtree-merge requires extra pull steps; subtree import is a one-time cost.
- Copy loses history; not acceptable for audit trail.

After import, the source repos (`~/repos/arc-agents`, `~/repos/arc-webui`) continue to exist and receive commits from their respective worktrees. The monorepo receives periodic subtree-pull updates:

```bash
# Update arc-agents in monorepo from source
cd ~/repos/arc
git subtree pull --prefix=packages/arc-agents ~/repos/arc-agents main
```

### arc-webui co-migration

Both `arc-framework-migrate-arc-agents-arc-pac` and `arc-framework-migrate-arc-webui-arc-pack` block on this decision. After this ADR merges:

1. `arc-framework-subtree-import-arc-agents-` unblocks (execute subtree-import arc-agents)
2. `arc-framework-subtree-import-arc-webui-i` unblocks (execute subtree-import arc-webui)
3. Both `arc-framework-update-bin-paths-in-cron-s-` and `arc-framework-update-arc-agents-referenc` depend on the imports completing first

arc-webui's `CHOICES.md` has a separate `M-0001` (webui never spawns agents directly — always: human → ledger row → worker pane). This constraint is preserved in the monorepo; arc-webui remains a pure UX surface, not a launchpad.

### Not a larger 'arc-oss' monorepo

Other repos (`trading`, `expert-horde`, `starlight-slm`, `OneNation`, etc.) are project-specific and do not belong in the `arc/` monorepo. The monorepo is for shared infrastructure packages (`arc-agents`, `arc-skills`, `arc-webui`, `arc-tui`, `arc-discord`) — the harness and its first-party UI/UX surfaces.

`arc-framework-arc-monorepo-generic-vault` enables the monorepo to be placed anywhere via `ARC_VAULT`; this ADR chooses the location (`~/repos/arc/`) and shape.

## Consequences

**Positive:**
- Single canonical home for arc-* infrastructure packages.
- Shared `system/` directory avoids duplicating config/schema across packages.
- Subtree-import preserves audit history from source repos.
- Monorepo path configurable via env vars (already done in `arc-framework-arc-monorepo-generic-vault`).

**Negative / accepted costs:**
- Two remotes to keep in sync (source repos + monorepo). Subtree-pull cadence must be established.
- `system/` at monorepo root vs inside a package — requires discipline not to accidentally commit package-specific stuff there.
- No cross-package dependency graph enforcement (no `pnpm workspace` or `bazel`). Bun workspaces are sufficient for the ≤6-package scale.

## Implementation checklist

After this ADR merges:

- [ ] User creates `~/repos/arc/` bare repo
- [ ] Worker executes `git subtree add --prefix=packages/arc-agents ~/repos/arc-agents main`
- [ ] Worker executes `git subtree add --prefix=packages/arc-webui ~/repos/arc-webui main`
- [ ] `bin/paths.ts` in monorepo copy updated to reflect new relative paths
- [ ] Cron/systemd entries updated to point to monorepo locations
- [ ] `~/repos/arc-agents/` and `~/repos/arc-webui/` remain as development worktrees (subtree pull targets)