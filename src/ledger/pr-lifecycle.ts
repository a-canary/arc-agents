// PR-lifecycle observability: when a tracked PR reaches MERGED, idempotently
// upsert a one-line ship post via the existing blog-write API.
//
// "Tracked" = the PR URL is already recorded on an issues row as pr_url.
// Only merged transitions are surfaced; open/closed are ignored.
// Idempotency: at most one blog row per (pr_url). Re-observation of the same
// merge returns the existing post instead of creating a duplicate.
//
// Defends on legacy ledgers whose `blog` table predates the pr_url/pr_state
// columns: runs an additive ALTER once if the columns are missing.

import { Database, SQLQueryBindings } from "bun:sqlite";
import { createBlogPost, type BlogPost } from "./blog";

export type PrState = "open" | "merged" | "closed";

export interface PrObservation {
  url: string;
  state: PrState;
}

export function ensureBlogPrColumns(db: Database): void {
  const cols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(blog)")
      .all()
      .map((r) => r.name),
  );
  if (!cols.has("pr_url")) db.run("ALTER TABLE blog ADD COLUMN pr_url TEXT");
  if (!cols.has("pr_state")) db.run("ALTER TABLE blog ADD COLUMN pr_state TEXT");
  if (!cols.has("pr_url") || !cols.has("pr_state")) {
    db.run("CREATE INDEX IF NOT EXISTS idx_blog_pr_url ON blog(pr_url) WHERE pr_url IS NOT NULL");
  }
}

export function observeTrackedPr(db: Database, obs: PrObservation): BlogPost | null {
  if (obs.state !== "merged") return null;
  ensureBlogPrColumns(db);

  const issue = db
    .query<{ id: string; project: string; title: string }, [string]>(
      "SELECT id, project, title FROM issues WHERE pr_url = ?",
    )
    .get(obs.url);
  if (!issue) return null;

  const existing = db
    .query<BlogPost, [string]>("SELECT * FROM blog WHERE pr_url = ?")
    .get(obs.url);
  if (existing) return existing;

  return createBlogPost(db, {
    project: issue.project,
    title: `Ship: ${issue.title}`,
    body_md: `${issue.title} — ${obs.url}`,
    origin_task_id: issue.id,
    pr_url: obs.url,
    pr_state: "merged",
  });
}
