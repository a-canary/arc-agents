// Blog-write API — ADR 0007 foundation.
// All functions operate on an open Database (caller owns lifecycle).

import { Database, SQLQueryBindings } from "bun:sqlite";
import { slugify, shortId } from "./db";
import { ensureBlogPrColumns } from "./pr-lifecycle";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BlogPostInput {
  project: string;
  title: string;
  body_md: string;
  artifact_path?: string;
  origin_task_id?: string;
  pr_url?: string;
  pr_state?: string;
}

export interface BlogPost extends BlogPostInput {
  id: string;
  created_at: number;
}

export interface ListBlogPostsOptions {
  project?: string;
  search?: string;
  choreOnly?: boolean;
}

// ─── ID minting ─────────────────────────────────────────────────────────────

/** Slug from title, uniquified if collision exists. */
function mintBlogId(db: Database, title: string): string {
  const base = slugify(title);
  const exists = db.query<{ id: string }, [string]>("SELECT id FROM blog WHERE id=?");
  let id = base;
  while (exists.get(id)) id = `${base}-${shortId()}`;
  return id;
}

// ─── createBlogPost ──────────────────────────────────────────────────────────

export function createBlogPost(db: Database, input: BlogPostInput): BlogPost {
  ensureBlogPrColumns(db);
  const id = mintBlogId(db, input.title);
  db.run(
    `INSERT INTO blog (id, project, title, body_md, artifact_path, origin_task_id, pr_url, pr_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.project,
      input.title,
      input.body_md,
      input.artifact_path ?? null,
      input.origin_task_id ?? null,
      input.pr_url ?? null,
      input.pr_state ?? null,
    ],
  );
  return {
    id,
    project: input.project,
    title: input.title,
    body_md: input.body_md,
    artifact_path: input.artifact_path,
    origin_task_id: input.origin_task_id,
    pr_url: input.pr_url,
    pr_state: input.pr_state,
    created_at: db
      .query<{ created_at: number }, [string]>("SELECT created_at FROM blog WHERE id=?")
      .get(id)!.created_at,
  };
}

// ─── listBlogPosts ───────────────────────────────────────────────────────────

/**
 * List blog posts, optionally filtered.
 *
 * choreOnly: if true, joins issues ON origin_task_id and returns only rows
 * where issues.type = 'cron' (i.e. posts originating from cron chores).
 * Automatically excludes manual posts (origin_task_id IS NULL).
 */
export function listBlogPosts(db: Database, opts: ListBlogPostsOptions = {}): BlogPost[] {
  ensureBlogPrColumns(db);
  const { project, search, choreOnly } = opts;

  if (choreOnly) {
    // INNER JOIN: excludes rows with no origin_task_id (manual posts).
    // Only rows whose origin is a cron-type issue pass through.
    let sql = `
      SELECT b.id, b.project, b.title, b.body_md, b.artifact_path,
             b.origin_task_id, b.pr_url, b.pr_state, b.created_at
      FROM blog b
      INNER JOIN issues i ON i.id = b.origin_task_id
      WHERE i.type = 'cron'
    `;
    const params: SQLQueryBindings[] = [];

    if (project) {
      sql += ` AND b.project = ?`;
      params.push(project);
    }
    if (search) {
      sql += ` AND (b.title LIKE ? OR b.body_md LIKE ?)`;
      const pat = `%${search}%`;
      params.push(pat, pat);
    }
    sql += ` ORDER BY b.created_at DESC`;

    return db.query<BlogPost, SQLQueryBindings[]>(sql).all(...params);
  }

  // Standard listing: project filter, full-text search, no join.
  let sql = `
    SELECT id, project, title, body_md, artifact_path, origin_task_id,
           pr_url, pr_state, created_at
    FROM blog
    WHERE 1=1
  `;
  const params: SQLQueryBindings[] = [];

  if (project) {
    sql += ` AND project = ?`;
    params.push(project);
  }
  if (search) {
    sql += ` AND (title LIKE ? OR body_md LIKE ?)`;
    const pat = `%${search}%`;
    params.push(pat, pat);
  }
  sql += ` ORDER BY created_at DESC`;

  return db.query<BlogPost, SQLQueryBindings[]>(sql).all(...params);
}
