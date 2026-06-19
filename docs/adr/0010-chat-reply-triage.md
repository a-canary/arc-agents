# ADR 0010 — Blog Feed + Reply / Triage / Grill Overlay (Slice 5)

**Status:** Accepted (slice 5 implementation) — 2026-05-29

## Context

The `/quest` 3-pane HUD (PRD-v1) is replaced by a **Blog Feed** as the primary human surface, served at `home-lab-1:8080`. Posts are rows in a new `blog` table in `~/vault/ledger.db`. Replies to posts flow through a JSONL chat log and an autonomous triage worker that decides whether to open a grill session or delegate work to a sprint/task. This ADR records the decisions made in slices 1 (blog table), 3 (feed page), and 5 (reply/triage/grill overlay).

## Decisions

### 1. Blog table (migration 020)

A separate `blog` table, **not** a polymorphic `kind` in the issues table:

```
CREATE TABLE blog (
  id              TEXT PRIMARY KEY,
  project         TEXT NOT NULL,
  title           TEXT NOT NULL,
  body_md         TEXT NOT NULL,
  artifact_path   TEXT,
  origin_task_id  TEXT REFERENCES issues(id),
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

**Why not reuse issues?** Issues are ephemeral work-tracking rows with a lifecycle (ready→merged). Blog posts are human-facing documents that should outlast their originating task. Mixing them causes confusion in dashboards and audit queries.

**Why not a separate DB?** Single SQLite file keeps `VACUUM` and backup simple. Foreign key to `issues` is nullable and best-effort (PRAGMA foreign_keys=ON required for enforcement; the webui's read-only connection may not enable it).

**Index strategy:** `idx_blog_project` for project-filtered queries; `idx_blog_created_at DESC` for reverse-chronological feed rendering.

### 2. JSONL chat log

Append-only JSONL file per blog post: `arc-ux/chat/<blog_id>.jsonl`.

Line schema:
```typescript
interface ChatLine {
  ts: number;        // unix seconds
  role: "user" | "assistant";
  body: string;
  blog_id: string;   // blog post id (slug)
  task_id: string;   // id of the 'read chat file and react' issues row
  spawned: string[]; // issue ids created by the triage worker
}
```

**Why JSONL over a table?** Simpler for SSE tailing (one file descriptor, no query engine). Append-only eliminates concurrency concerns. The triage worker updates `spawned` atomically via write-to-tmp + rename.

**Path:** `~/vault/arc-ux/chat/<slug>.jsonl`. `arc-ux/` under the vault root keeps chat logs with the ledger without mixing into the ledger file itself.

### 3. Reply flow

1. User submits reply in feed UI.
2. **Server** (arc-webui calls `bin/chat-reply.ts`) appends a `role:user` chat line to `arc-ux/chat/<blog_id>.jsonl`.
3. Same call creates a `kind=task` issues row: title=`read chat file and react: <blog_id>`, `pool=build`, `tier=mvp`, `state=ready`.
4. UI optimistically echoes the reply with a "triaging…" pill. Never blocks on step 3.
5. Pill transitions via SSE: "triaging…" → "grill started" (opens overlay) OR "queued sprint #id" (links the task).

### 4. Triage worker

`bin/triage-chat.ts` — processes pending chat lines (role=user, body non-empty, spawned=[]).

**Decision rules (MVP):**
- Grill trigger regex: `/\b(grill|review|discuss|question|talk|triage|explore|analyse|think)\b/i`
- Matches → creates `kind=sprint` (grill session)
- No match → creates `kind=task` (delegate)

**Subsequent replies:** If a non-terminal sprint exists for the same `blog_id`, delegate tasks are created as children of that sprint (via `blocked_by` referencing the sprint).

**Output:** Triage worker writes spawned issue ids back into the chat line's `spawned` array, unblocking the SSE poll in the UI.

### 5. Grill overlay

A modal in arc-webui that SSE-tails `arc-ux/chat/<blog_id>.jsonl`. User types → `role:user` lines appended via `chat-reply.ts`; triage worker appends `role:assistant` lines.

**SSE stream:** `GET /grill/:blog_id` — server-sent events, one event per new JSONL line. Client EventSource.

**No second transport:** Grill uses the same JSONL file as inline replies. One file, one SSE stream, unified history.

### 6. arc-chat.ts deprecation note

`bin/arc-chat.ts` (ledger `chat_in`/`reply` kind rows) is superseded for the human surface by this ADR. **Do not delete** `arc-chat.ts` until all existing threads are migrated. Slice 5 does not delete it; a future slice will.

## Consequences

- `blog` table added (migration 020)
- `chat-reply.ts` becomes the canonical write path for human replies
- `triage-chat.ts` runs as a background process or cron, processing pending lines
- arc-webui grill overlay reads the same JSONL as inline replies
- `arc-chat.ts` remains but is no longer the primary human surface

## Out of scope (future slices)

- FTS5 search over blog posts (LIKE is sufficient for MVP)
- Chat message editing / deletion (append-only is intentional)
- Grill session resumption across restarts (sprint state is the resumability anchor)
- Multi-user / auth (solo dev assumption holds)
