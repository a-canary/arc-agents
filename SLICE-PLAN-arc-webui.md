# arc-webui slice plan

2-panel mobile-first webui replacing chat/encounters/map/kanban.
HITL = interviewer thread triage with pre-drafted replies.
AFK = artifact-keyed DAG of ledger state with tech-tree navigation.

## Locked decisions

- **Stack:** SvelteKit (Bun adapter) + d3-dag for Sugiyama layout. Picked over Astro+Solid (islands split mental model for SSE-heavy app) and Next (React weight + RSC churn unjustified for solo mobile-first surface). SvelteKit gives first-class SSE, single isomorphic codebase, smallest hot-reload cost, and graph libs are framework-agnostic. **HITL taste prompt emitted; recommendation = SvelteKit, optimistic forward.**
- **Sync:** SSE; server binds tailscale0
- **Auth:** tailscale-only, hard-fail if interface missing
- **Drafts:** pre-draft top-3 chat_in; cache on row; regenerate on rank change
- **Defer:** rejoin queue at `priority - 100`
- **Pause:** `state=paused`, hidden from DAG, waiter skips
- **Artifacts:** filepath on row; viewable in arc-webui
- **DAG window:** in-flight + hitl_blocked + pending + last 10 completed (or 1-deep completed parents of in-flight)
- **Layout:** Sugiyama-style layered, in-flight center, completed left, pending right; cache, invalidate on topology change
- **Hover:** 10-word status
- **Click:** open thread in HITL panel
- **Pending click:** discuss prioritize/cancel/split
- **In-flight no-artifacts:** "no output yet" placeholder
- **Removal:** chat/encounters/map/kanban → `to-trash.ts` after v1 ships

## Slices

### S0 — Decomposition interview
Interviewer pane session with user. Produce: stack pick, exact slice count, dep order, MVP cut line. Output: amended SLICE-PLAN with PRs sized.
**Role:** interviewer
**Blocks:** all below

### S1 — Schema deltas to ledger
Add columns: `priority INT`, `paused BOOL`, `deferred_at TS`, `artifact_dir TEXT`, `draft_md TEXT`.
Add `parent_id` (already requested by slice-tavern). Migration with backfill.
**Role:** developer
**Blocks:** S2, S5, S6

### S2 — SSE ledger-delta server
`bin/webui-server.ts`: binds tailscale0, fails if iface missing. Polls ledger 1s, emits SSE deltas. One endpoint per panel.
**Role:** developer
**Depends:** S1

### S3 — Reference image dossier
6 game tech-tree screenshots (Civ, Factorio, PoE, Stellaris, FTL, Slay-the-Spire) + 4 productivity (Linear graph, Height, Notion timeline, Excalidraw). Saved to `assets/ref/`. User narrows to 2-3 visual targets.
**Role:** interviewer
**Blocks:** S4

### S4 — Mobile paper sketch + claude-design pass
Sketch HITL + AFK at 375px and 1024px. Run /claude-design. Output: tokens, components, motion spec.
**Role:** developer
**Depends:** S3

### S5 — HITL panel
Mobile-first. Top-1 visible, pan to top-2/top-3. Renders draft_md + alternatives + custom textbox. Submit → ledger chat_out row.
**Role:** developer
**Depends:** S2, S4

### S6 — AFK DAG panel
Sugiyama layout. Zoom/pan. Hover 10-word. Click node → flips to HITL with thread. Artifact gallery in thread overlay (lazy-load for >10 files).
**Role:** developer
**Depends:** S2, S4

> ⚠️ **Blocked on HITL design spec:** `webui-afk-dag-panel-d3-dag-sugiyama-layo` (empty body_md, type=HITL) must be resolved before S6 implementation starts. Open decisions: column mapping, window scoping, zoom/pan target, hover content, click target, artifact gallery strategy. See `s6-afk-dag-panel-write-design-spec` for the spec template.

### S7 — Pause/defer wiring
Pause button on AFK node → `state=paused`. Defer button → `priority -= 100`, rejoin queue. Waiter respects both.
**Role:** developer
**Depends:** S1, S6

### S8 — Pre-drafter interviewer loop
On chat_in arriving at rank ≤3, interviewer generates draft_md + 2-3 alternatives. Cached on row. Regenerate on rank shuffle.
**Role:** interviewer
**Depends:** S1, S5

### S9 — Trash old surfaces
`to-trash.ts` on chat/, encounters/, map/, kanban/ routes + assets. Confirm no live links from director cycle outputs.
**Role:** admin
**Depends:** S5, S6, S7, S8 merged + 7-day soak

### S10 — Auth hardening verification
Verify tailscale ACL, attempt connection from non-tailnet IP (expect refused). Document in CHOICES.md.
**Role:** admin
**Depends:** S2

## Critical path to MVP

**MVP cut line: S1 → S2 → S5 + S6.** Ship when HITL panel renders top-3 drafts and AFK DAG renders in-flight/blocked/pending with click-to-thread. S4 folded into S5/S6 as a single inline tokens pass (no separate sketch gate — paper-sketch + claude-design happens in-line per panel). S3 (reference dossier) parallels S1/S2 and informs S4-inline; user narrows targets via HITL taste prompt.

Post-MVP (in-order, soak between): S7 (pause/defer) → S8 (pre-drafter) → 7-day soak → S9 (trash old surfaces). S10 (auth verification) runs immediately after S2 merges; non-blocking for MVP ship but blocks public-network exposure.

## Exact slice count: 11 (S0–S10)

S0 = this row (decomposition interview, doc deliverable).
S1–S10 = developer/interviewer/admin tickets to be created as ledger rows by the next worker claiming the parent (arc-webui-2-panel-rewrite-hitl-afk).

## Dep order (topological)

```
S0 ──► S1 ──► S2 ──► S5 ──► (MVP)
   │     │     │      │
   │     │     │      ▼
   │     │     └────► S6 ──► S7
   │     │                    │
   │     └──► S8 ◄─────────── S5
   │                           │
   └──► S3 ──► (S4 inlined into S5/S6)
                                │
              S2 ──► S10        ▼
                          S5+S6+S7+S8 + 7d soak ──► S9
```

## Sizing (rough PR scope)

- **S1 schema deltas:** ~200 LOC migration + tests. 1 PR.
- **S2 SSE server:** ~300 LOC server + 100 LOC SSE client lib. 1 PR.
- **S3 reference dossier:** asset commit + 1-paragraph review doc. 1 PR.
- **S5 HITL panel:** ~800 LOC (mobile-first carousel + draft renderer + submit). 1 PR.
- **S6 AFK DAG panel:** ~1000 LOC (d3-dag layout + zoom/pan + thread overlay + artifact gallery). 1 PR.
- **S7 pause/defer:** ~150 LOC button wiring + waiter changes. 1 PR.
- **S8 pre-drafter loop:** ~250 LOC interviewer frame + cache invalidation. 1 PR.
- **S9 trash old surfaces:** mechanical to-trash + link-grep verification. 1 PR.
- **S10 auth verification:** doc + smoke test. 1 PR.

Total MVP code surface: ~2400 LOC across 4 PRs (S1, S2, S5, S6). Achievable in 4 single-worker sessions.
