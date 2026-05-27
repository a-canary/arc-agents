# ADR 0007 — Blog Feed Data Model

## Status

Accepted — implementation in progress (slice: `slice-1-blog-table-blog-write-api-adr-00`).

## Context

The `/quest` 3-pane HUD (ADR 0002) is being retired in favor of a **BLOG FEED** human surface
at `home-lab-1:8080`. The blog feed serves a different audience and cadence than the ledger's
`issues` table:

- **Blog posts** — human-readable summaries of completed work, decisions, and learnings.
  Written by agents after merging a slice, by cron chores, or manually by the operator.
  Long-form, markdown, optionally with artifact attachments.
- **Tasks/chores** — continue to use the existing `issues` table. A chore is `issues.type='cron'`.
  No new `task` table is needed.

The chat log (JSONL in `arc-ux/chat/<slug>.jsonl`) remains append-only JSONL and is out of scope
for this ADR.

## Decision

### Separate `blog` table (not a polymorphic `kind` on `issues`)

A separate `blog` table is used rather than a `kind='blog'` column on `issues`. Rationale:

| Factor | Polymorphic `kind` | Separate `blog` table |
|---|---|---|
| Schema clarity | Single table with many NULLs | Clean, dedicated columns |
| Query ergonomics | Filter by `kind='blog'` | Direct table access |
| `origin_task_id` FK | Requires nullable FK on issues | First-class FK on `blog` |
| Index isolation | Blog queries scan `issues` rows | Isolated indexes on `blog` |
| Future evolution | Blog fields require schema migration | Independent migration path |

The `issues` table already has `artifact_dir` for per-row artifacts. `blog.artifact_path` is a
separate field because blog posts may have multiple artifacts and a different access pattern
(e.g. CDN-served images vs. agent scratch files).

### Schema

```sql
CREATE TABLE blog (
  id             TEXT PRIMARY KEY,
  project        TEXT NOT NULL,
  title          TEXT NOT NULL,
  body_md        TEXT NOT NULL,
  artifact_path  TEXT,          -- nullable; manual posts have no artifact
  origin_task_id TEXT REFERENCES issues(id),  -- nullable; manual posts have no origin
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

**Indexes:**

- `idx_blog_project` — project-scoped feed queries.
- `idx_blog_created_at DESC` — chronological feed (newest first).
- `idx_blog_origin_task_id` (partial, WHERE `origin_task_id IS NOT NULL`) — origin traversal.

### API

Two functions in `src/ledger/blog.ts`:

- `createBlogPost(db, {project, title, body_md, artifact_path?, origin_task_id?})` — mints a
  slug-derived id, inserts, returns the full `BlogPost` record.
- `listBlogPosts(db, {project?, search?, choreOnly?})` — returns `BlogPost[]` ordered by
  `created_at DESC`. `choreOnly` INNER JOINs `issues` and filters `type='cron'`, excluding
  manual posts.

### Ruled-out approaches

1. **Polymorphic `kind='blog'` on `issues`** — rejected per table above.
2. **Separate `task` table for chores** — rejected. `issues.type='cron'` suffices; a separate
   table would duplicate infrastructure and split the dispatch model.
3. **Chat as a table** — rejected. Chat is append-only JSONL in `arc-ux/chat/`. A chat table would
   require WAL-safe batch inserts and is out of scope for this slice.
4. **Blog title uniqueness** — not enforced. Multiple posts may share a title slug; the id is
   uniquified via `mintBlogId` with a random suffix.

## Consequences

**Positive:**
- Clean separation between dispatch state (`issues`) and human-facing content (`blog`).
- `origin_task_id` FK enforces referential integrity — blog posts must originate from a real
  ledger row or be manually created (NULL origin).
- `choreOnly` query path joins `issues.type` at query time, avoiding redundant storage.

**Negative:**
- New migration dependency for any slice that writes to `blog`.
- FK constraint requires `PRAGMA foreign_keys = ON` to be set on the DB connection; SQLite
  enables it OFF by default.

## Implementation notes

1. `PRAGMA foreign_keys = ON` must be set on the database connection before writing to `blog`.
   The migration does not set it (PRAGMAs inside `db.transaction()` have unreliable semantics).
2. `created_at` is in unix seconds (`strftime('%s','now')`) to match the `issues` convention.
3. The `blog` table is **not** created by migration 020 until it is applied. Code that assumes
   the table exists (e.g. webui, blog skill) must be gated behind migration availability.
4. Future slices will add a `blog-read` API and integrate the blog skill for pre-PR draft posts.
