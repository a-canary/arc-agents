# Release Tagging Plan — Arc Monorepo

## Context

The arc monorepo (`arc/`) will be assembled via `git subtree add` from two source repos:
- **arc-agents** — ledger, workers, factory, interviewer, bookie (public)
- **arc-webui** — Tailscale-only web UI (public)

A third private component, **arc-skills**, is NOT part of the monorepo. It stays separate and private.

Subtree-merge strategy preserves full commit history of both source repos.

---

## Pre-Merge Secret Scan

Before each subtree-merge, run gitleaks against full history:

```bash
# arc-agents scan
cd /path/to/arc-agents
gitleaks detect --source=. --config .gitleaks.toml --verbose

# arc-webui scan
cd /path/to/arc-webui
gitleaks detect --source=. --verbose
```

- **arc-agents**: 492 commits scanned → 0 leaks (2 false-positives suppressed by `.gitleaks.toml` path allowlist targeting `.gitleaksignore` itself)
- **arc-webui**: 197 commits scanned → 0 leaks

Scan results are recorded in `.gitleaksignore` (commit `6601f6b` on `worker/conjecture-secret-scan-clean` branch; not yet merged to main).

Merge gate (`bin/merge-gate.sh`) now includes a gitleaks gate (Gate 2) that runs `gitleaks detect --config .gitleaks.toml` on every PR.

---

## Tagging Policy

### v0.1.0-alpha — First Private Push

- **Trigger**: First push to any private branch or fork that includes the merged monorepo contents
- **Tag**: `v0.1.0-alpha`
- **Format**: `git tag v0.1.0-alpha <sha>` + `git push origin v0.1.0-alpha`
- **No release notes required**; alpha tags signal "internal/unstable"
- This tag can be re-set (amended) as long as the push is still private

### v0.1.0 — First Public Push After User Approval

- **Trigger**: User explicitly approves first public-facing release via Discord DM
- **Approval record**: A `kind=note` ledger event must be emitted documenting the approval (actor=director, body contains user DM text + timestamp). The event id is noted in the commit message of the stable tag commit.
- **Tag**: `v0.1.0`
- **Format**: `git tag v0.1.0 <sha>` + `git push origin v0.1.0` + GitHub release creation
- **Requires**: User DM approval (per `~/vault/user.md` — MS-003 LLM democratization mission; user sets public-facing scope)
- **Release notes**: minimum — list of merged slices since v0.1.0-alpha

### Subsequent Releases

- **Patch**: `v0.1.X` — bug fixes, no API changes
- **Minor**: `v0.X.0` — new features, backwards-compatible
- **Major**: `vX.0.0` — breaking changes (requires user approval for public push; same ledger event procedure as v0.1.0)

---

## Manual Commands

```bash
# Tag alpha (private push)
git tag v0.1.0-alpha <sha>
git push origin v0.1.0-alpha

# Tag stable (after user approval)
git tag v0.1.0 <sha>
git push origin v0.1.0

# Verify no leaks before tagging
gitleaks detect --source=. --config .gitleaks.toml
```

---

## Notes

- Tags are lightweight (not annotated) for alpha; annotated + signed for stable releases
- The `arc/` monorepo root will get its own `package.json` with `version` field updated via `npm version` before each stable tag
- CI (`.github/workflows/gitleaks.yml`) gates all PRs and main-push with gitleaks; the merge-gate locally mirrors this gate
