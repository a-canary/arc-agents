# arc-webui slice plan

2-panel mobile-first webui replacing chat/encounters/map/kanban.
HITL = interviewer thread triage with pre-drafted replies.
AFK = artifact-keyed DAG of ledger state with tech-tree navigation.

## Locked decisions

- **Stack:** TBD in S1 (Astro+Solid vs SvelteKit vs Next — pick during decomposition interview)
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

S0 → S1 → S2 → S4 → S5 + S6 → S7 → S8 → ship.
S3 parallels S1/S2. S9/S10 post-ship.
