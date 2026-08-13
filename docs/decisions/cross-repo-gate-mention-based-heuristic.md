# Decision: Cross-Repo Gate — Mention-Based Heuristic for Cross-Repo Linking

**Date:** 2026-07-11 (row created)
**Status:** accepted
**Row:** `clarify-docs-cross-repo-gate-mention-bas`
**Source:** `src/ledger/cross-repo-gate.ts` ponytail annotation (line 15)
**Observed in:** `000242-hygiene-arc-agents-ponytail-audit`

---

## TL;DR

The cross-repo gate (`detectCrossRepoTarget`) uses a text-heuristic (mention of
`a-canary/<repo>` in title/body, or `<project>:` title prefix) to detect ready
tasks mis-routed to the wrong project's worktree. The heuristic is intentionally
conservative: it parks the row `hitl=1` rather than re-routing, leaving
adjudication to the existing gate-triage arm (opus judge). False positives
cost one 2-hour park window + one opus call. If the false-positive rate becomes
a problem, the upgrade path is an explicit `target-repo:` body marker emitted by
the minting step.

## Design

```
detectCrossRepoTarget(project, title, body):
  // 1. Own-repo mention → correctly routed, skip
  if own slug found in text: return null

  // 2. Foreign repo slug mentions
  targets = set of known projects mentioned as a-canary/<repo>
  if exactly 1 foreign project: return it

  // 3. Minting title prefix
  return detectTitlePrefixTarget(project, title, ownSlug)

detectTitlePrefixTarget(project, title, ownSlug):
  m = /^\s*([\w.-]+)\s*:/ (e.g. "webui: ...")
  if m && resolves to known project ≠ own project:
    return target
  return null
```

Key properties:

1. **Parks, does not re-route.** The gate sets `hitl=1` and appends a
   `cross-repo-gate` note event. The existing `gate-triage` arm
   (`ready+hitl=1` tasks >2h → opus judge) adjudicates: auto verdict lifts
   the park, human verdict keeps it. The `cross-repo-gate` event prevents
   re-parking on the next factory tick (no park/unpark loop).

2. **Two detection arms.** (a) Slug arm: scans for `a-canary/<repo>` mentions
   in title+body, resolves to a known project. Only fires when exactly one
   foreign repo slug is present — zero, own-repo, ambiguous multi-repo, and
   unknown slugs all return null and let the claim proceed. (b) Title-prefix
   arm: minted titles follow `<project-or-repo-name>:` convention (e.g.
   `"webui: ..."`, `"ke: ..."`). Resolves via bare-name lookup against
   project keys AND GitHub repo basenames.

3. **False-positive cost.** Each false park adds 2-hour wait (the shortest
   gate-triage interval) plus one opus call to adjudicate and unpark. This
   is acceptable because (a) the gate runs as a factory tick, not a claim-time
   gate, so a false park delays but does not block work, and (b) the
   `cross-repo-gate` event makes the opus verdict permanent — the row is never
   re-parked.

4. **Known false-positive class.** An `arc-agents` row titled `"webui: ..."`
   that really targets `arc-agents`' own `bin/webui-server.ts` triggers the
   title-prefix arm. One opus unpark settles it permanently (the
   `cross-repo-gate` event bars re-parking).

## Upgrade path: explicit `target-repo:` body marker

If the false-positive rate becomes a problem (e.g. the title-prefix arm fires
too often on `arc-agents` rows mentioning other projects), the minting step
can emit an explicit body marker:

```
target-repo: <project>
```

The detector would then use this marker for exact-match routing instead of
text heuristics. In the absence of a `target-repo:` marker, the heuristic
continues to apply. This upgrade requires no schema change — the marker is
a convention in the `body_md` text, parsed by an additional scan in
`detectCrossRepoTarget`.

## Why mention-based and not minting-enforced

- **Minting is not the only source.** Tasks created by `bin/ledger.ts create`
  directly (CLI), by migration, or by external tools may not follow the minting
  convention. The heuristic catches cross-repo mis-routing regardless of
  origin.

- **Silent mis-routing is worse than a false park.** A worker claiming a
  webui-targeted task from the arc-agents pool lands in the arc-agents worktree
  and cannot complete the work. The resulting failure (routing-mismatch) is
  confusing and wastes more than 2h. A false park is a 2h delay + one opus
  call — cheaper than the failure mode it prevents.

- **Deterministic text heuristics cannot distinguish** "work in repo X" from
  "work about repo X". Parking with opus adjudication is the correct safety
  posture: a human (or opus judge) can make that distinction.

## Cross-references

- `src/ledger/cross-repo-gate.ts` — `detectCrossRepoTarget()` (line ~71),
  `detectTitlePrefixTarget()` (line ~100), `sweepCrossRepoGate()` (line ~114)
- `src/ledger/merge-guard.ts` — `PROJECT_GH_REPO` map (the canonical
  project→repo mapping shared by both the merge guard and the cross-repo gate)
- `docs/decisions/feedback-collector-single-minimax-call.md` — same ponytail
  annotation pattern from the same hygiene audit
- `000242-hygiene-arc-agents-ponytail-audit` — the hygiene run that surfaced
  this as undocumented
