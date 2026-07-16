// Blog API tests — ADR 0007 foundation.
// All DBs are throwaway in-memory — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { createBlogPost, listBlogPosts, renderPrChip } from "./blog";

function blogFresh(): Database {
  const db = new Database(":memory:");
  // SQLite FK constraints are OFF by default; enable them globally so the
  // REFERENCES clause on origin_task_id is actually enforced.
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// ── createBlogPost ────────────────────────────────────────────────────────────

test("createBlogPost inserts a row and returns it with id and created_at", () => {
  const db = blogFresh();
  const post = createBlogPost(db, {
    project: "arc-agents",
    title: "Hello World",
    body_md: "# Hello\nThis is a blog post.",
  });
  expect(post.id).toMatch(/^hello-world/);
  expect(post.project).toBe("arc-agents");
  expect(post.title).toBe("Hello World");
  expect(post.body_md).toBe("# Hello\nThis is a blog post.");
  expect(post.artifact_path).toBeUndefined();
  expect(post.origin_task_id).toBeUndefined();
  expect(post.created_at).toBeGreaterThan(0);
});

test("createBlogPost with artifact_path and origin_task_id", () => {
  const db = blogFresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('task-1','p','t','b','cron','merged','task')`,
  );
  const post = createBlogPost(db, {
    project: "arc-agents",
    title: "With artifact",
    body_md: "Body",
    artifact_path: "/tmp/screenshot.png",
    origin_task_id: "task-1",
  });
  expect(post.artifact_path).toBe("/tmp/screenshot.png");
  expect(post.origin_task_id).toBe("task-1");
});

test("createBlogPost id is unique across calls", () => {
  const db = blogFresh();
  const a = createBlogPost(db, { project: "p", title: "Same Title", body_md: "a" });
  const b = createBlogPost(db, { project: "p", title: "Same Title", body_md: "b" });
  expect(a.id).not.toBe(b.id);
});

test("createBlogPost rejects unknown origin_task_id (FK violation)", () => {
  const db = blogFresh();
  expect(() =>
    createBlogPost(db, {
      project: "p",
      title: "Bad FK",
      body_md: "b",
      origin_task_id: "nonexistent",
    }),
  ).toThrow();
});

// ── listBlogPosts — base ─────────────────────────────────────────────────────

test("listBlogPosts returns posts in DESC created_at order", () => {
  const db = blogFresh();
  // Insert with explicit distinct timestamps so ordering is deterministic
  // regardless of how fast the test runs.
  db.run(
    `INSERT INTO blog (id, project, title, body_md, created_at)
     VALUES ('p1','p','First','f',1000)`,
  );
  db.run(
    `INSERT INTO blog (id, project, title, body_md, created_at)
     VALUES ('p2','p','Second','s',2000)`,
  );
  db.run(
    `INSERT INTO blog (id, project, title, body_md, created_at)
     VALUES ('p3','p','Third','t',3000)`,
  );
  const rows = listBlogPosts(db);
  expect(rows.length).toBe(3);
  // DESC order: newest first
  expect(rows[0]!.title).toBe("Third");
  expect(rows[1]!.title).toBe("Second");
  expect(rows[2]!.title).toBe("First");
});

test("listBlogPosts filters by project", () => {
  const db = blogFresh();
  createBlogPost(db, { project: "arc-agents", title: "A", body_md: "a" });
  createBlogPost(db, { project: "arc-ux", title: "B", body_md: "b" });
  const rows = listBlogPosts(db, { project: "arc-agents" });
  expect(rows.length).toBe(1);
  expect(rows[0]!.title).toBe("A");
});

test("listBlogPosts search matches title", () => {
  const db = blogFresh();
  createBlogPost(db, { project: "p", title: "SQLite migration guide", body_md: "intro" });
  createBlogPost(db, { project: "p", title: "TypeScript tips", body_md: "intro" });
  const rows = listBlogPosts(db, { search: "SQLite" });
  expect(rows.length).toBe(1);
  expect(rows[0]!.title).toBe("SQLite migration guide");
});

test("listBlogPosts search matches body_md", () => {
  const db = blogFresh();
  createBlogPost(db, { project: "p", title: "Intro post", body_md: "Using SQLite WAL mode" });
  createBlogPost(db, { project: "p", title: "Intro post 2", body_md: "Plain intro" });
  const rows = listBlogPosts(db, { search: "WAL mode" });
  expect(rows.length).toBe(1);
  expect(rows[0]!.title).toBe("Intro post");
});

test("listBlogPosts combined project + search filters", () => {
  const db = blogFresh();
  createBlogPost(db, { project: "p1", title: "SQLite in p1", body_md: "b" });
  createBlogPost(db, { project: "p2", title: "SQLite in p2", body_md: "b" });
  const rows = listBlogPosts(db, { project: "p1", search: "SQLite" });
  expect(rows.length).toBe(1);
  expect(rows[0]!.project).toBe("p1");
});

test("listBlogPosts returns empty array when no matches", () => {
  const db = blogFresh();
  createBlogPost(db, { project: "p", title: "A", body_md: "b" });
  expect(listBlogPosts(db, { project: "nonexistent" })).toHaveLength(0);
});

test("listBlogPosts with no options returns all posts", () => {
  const db = blogFresh();
  createBlogPost(db, { project: "p", title: "A", body_md: "a" });
  createBlogPost(db, { project: "q", title: "B", body_md: "b" });
  expect(listBlogPosts(db)).toHaveLength(2);
});

// ── listBlogPosts — choreOnly ────────────────────────────────────────────────

test("choreOnly returns posts whose origin_task_id is a cron issue", () => {
  const db = blogFresh();
  // Cron task
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('chore-1','p','chore','b','cron','merged','task')`,
  );
  // Non-cron task
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('task-2','p','task','b','mvp','ready','task')`,
  );
  createBlogPost(db, { project: "p", title: "Cron post", body_md: "b", origin_task_id: "chore-1" });
  createBlogPost(db, { project: "p", title: "Manual post", body_md: "b" }); // no origin
  createBlogPost(db, { project: "p", title: "MVP post", body_md: "b", origin_task_id: "task-2" });

  const rows = listBlogPosts(db, { choreOnly: true });
  expect(rows.length).toBe(1);
  expect(rows[0]!.title).toBe("Cron post");
});

test("choreOnly excludes manual posts (NULL origin_task_id)", () => {
  const db = blogFresh();
  createBlogPost(db, { project: "p", title: "Manual", body_md: "b" });
  expect(listBlogPosts(db, { choreOnly: true })).toHaveLength(0);
});

test("choreOnly with project filter", () => {
  const db = blogFresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('c1','p1','c','b','cron','merged','task'),
            ('c2','p2','c','b','cron','merged','task')`,
  );
  createBlogPost(db, { project: "p1", title: "P1 cron", body_md: "b", origin_task_id: "c1" });
  createBlogPost(db, { project: "p2", title: "P2 cron", body_md: "b", origin_task_id: "c2" });

  const rows = listBlogPosts(db, { project: "p1", choreOnly: true });
  expect(rows.length).toBe(1);
  expect(rows[0]!.project).toBe("p1");
});

test("choreOnly with search filter", () => {
  const db = blogFresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('cc1','p','c','b','cron','merged','task')`,
  );
  createBlogPost(db, { project: "p", title: "SQLite cron report", body_md: "b", origin_task_id: "cc1" });
  createBlogPost(db, { project: "p", title: "TypeScript cron report", body_md: "b", origin_task_id: "cc1" });

  const rows = listBlogPosts(db, { search: "SQLite", choreOnly: true });
  expect(rows.length).toBe(1);
  expect(rows[0]!.title).toBe("SQLite cron report");
});

// ── pr_url / pr_state ─────────────────────────────────────────────────────────

test("createBlogPost round-trips pr_url and pr_state", () => {
  const db = blogFresh();
  const post = createBlogPost(db, {
    project: "arc",
    title: "PR-linked post",
    body_md: "body",
    pr_url: "https://github.com/x/y/pull/1",
    pr_state: "merged",
  });
  expect(post.pr_url).toBe("https://github.com/x/y/pull/1");
  expect(post.pr_state).toBe("merged");

  const [row] = listBlogPosts(db, { project: "arc" });
  expect(row!.pr_url).toBe("https://github.com/x/y/pull/1");
  expect(row!.pr_state).toBe("merged");
});

test("createBlogPost leaves pr_url/pr_state null when omitted", () => {
  const db = blogFresh();
  const post = createBlogPost(db, { project: "arc", title: "No PR", body_md: "body" });
  expect(post.pr_url).toBeUndefined();
  expect(post.pr_state).toBeUndefined();

  const [row] = listBlogPosts(db, { project: "arc" });
  expect(row!.pr_url).toBeNull();
  expect(row!.pr_state).toBeNull();
});

// ── renderPrChip ───────────────────────────────────────────────────────────────

test("renderPrChip returns empty string when no pr_url", () => {
  expect(renderPrChip({ pr_url: undefined, pr_state: undefined })).toBe("");
});

test("renderPrChip defaults to open when pr_state is missing", () => {
  const html = renderPrChip({ pr_url: "https://github.com/x/y/pull/2", pr_state: undefined });
  expect(html).toBe(
    `<a class="pr-chip pr-chip--open" href="https://github.com/x/y/pull/2">open</a>`,
  );
});

test("renderPrChip renders merged and closed states", () => {
  expect(renderPrChip({ pr_url: "https://x/1", pr_state: "merged" })).toBe(
    `<a class="pr-chip pr-chip--merged" href="https://x/1">merged</a>`,
  );
  expect(renderPrChip({ pr_url: "https://x/1", pr_state: "closed" })).toBe(
    `<a class="pr-chip pr-chip--closed" href="https://x/1">closed</a>`,
  );
});

test("renderPrChip escapes HTML-unsafe characters in pr_url", () => {
  const html = renderPrChip({ pr_url: `https://x/1?a=1&b="<b>"`, pr_state: "open" });
  expect(html).toBe(
    `<a class="pr-chip pr-chip--open" href="https://x/1?a=1&amp;b=&quot;&lt;b&gt;&quot;">open</a>`,
  );
});
