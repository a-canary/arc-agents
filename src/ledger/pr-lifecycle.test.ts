import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { listBlogPosts } from "./blog";
import { migrate } from "./migrate";
import { observeTrackedPr } from "./pr-lifecycle";

function fresh(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.run("ALTER TABLE blog ADD COLUMN pr_url TEXT");
  db.run("ALTER TABLE blog ADD COLUMN pr_state TEXT");
  db.run(`INSERT INTO issues (id, project, title, body_md, type, state, kind, pr_url)
          VALUES ('ship-task', 'arc-agents', 'Ship merge hook', '', 'mvp', 'review', 'task',
                  'https://github.com/a-canary/arc-agents/pull/42')`);
  return db;
}

test("observing a tracked merged PR twice leaves exactly one ship post", () => {
  const db = fresh();
  const observation = {
    url: "https://github.com/a-canary/arc-agents/pull/42",
    state: "merged" as const,
  };

  const first = observeTrackedPr(db, observation);
  const second = observeTrackedPr(db, observation);
  const posts = listBlogPosts(db);

  expect(first?.id).toBe(second?.id);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    project: "arc-agents",
    origin_task_id: "ship-task",
    pr_url: observation.url,
    pr_state: "merged",
  });
  expect(posts[0]!.body_md).toBe("Ship merge hook — https://github.com/a-canary/arc-agents/pull/42");
});

test("non-merged and untracked PR observations do not create posts", () => {
  const db = fresh();

  expect(observeTrackedPr(db, {
    url: "https://github.com/a-canary/arc-agents/pull/42",
    state: "open",
  })).toBeNull();
  expect(observeTrackedPr(db, {
    url: "https://github.com/a-canary/arc-agents/pull/99",
    state: "merged",
  })).toBeNull();
  expect(listBlogPosts(db)).toHaveLength(0);
});
