// Tests for the `ledger feedback` intake command (migration 022_feedback_table,
// PRD self-guided-portal §Feedback). Trust-tiered source; flag-only.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "feedback-test-"));
  const path = join(dir, "t.db");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("feedback inserts a row and mints an fb- id", async () => {
  const { path, cleanup } = freshDb();
  try {
    const r = await $`bun ${cli} feedback --db ${path} --project arc-webui --body ${"feed pane unstyled on mobile"} --source ai-agent --context ${"/feed"}`.quiet();
    const res = JSON.parse(r.stdout.toString());
    expect(res.logged).toBe(true);
    expect(res.id).toMatch(/^fb-/);
    expect(res.source).toBe("ai-agent");

    const db = new Database(path);
    const row = db.query<{ project: string; source: string; body_md: string; context: string; state: string }, [string]>(
      "SELECT project, source, body_md, context, state FROM feedback WHERE id=?",
    ).get(res.id)!;
    db.close();
    expect(row.project).toBe("arc-webui");
    expect(row.source).toBe("ai-agent");
    expect(row.body_md).toBe("feed pane unstyled on mobile");
    expect(row.context).toBe("/feed");
    expect(row.state).toBe("new"); // defaults to new
  } finally {
    cleanup();
  }
});

test("--source defaults to ai-agent when omitted", async () => {
  const { path, cleanup } = freshDb();
  try {
    const r = await $`bun ${cli} feedback --db ${path} --project arc-agents --body ${"flag parser drops --x=y values"}`.quiet();
    expect(JSON.parse(r.stdout.toString()).source).toBe("ai-agent");
  } finally {
    cleanup();
  }
});

test("coexists with a pre-existing arc-webui-shaped feedback table (ALTER backfills cols)", async () => {
  // arc-webui bootstraps its own narrower feedback table on the shared DB. The
  // migration must ADD the agent-side columns to it, not collide, so both write.
  const { path, cleanup } = freshDb();
  try {
    const seed = new Database(path);
    seed.run(`CREATE TABLE feedback (
      id TEXT PRIMARY KEY, project TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'direct',
      submitter TEXT, body_md TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new',
      theme_id TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`);
    seed.run("INSERT INTO feedback (id, project, source, submitter, body_md) VALUES (?,?,?,?,?)",
      ["web-1", "arc-webui", "direct", "aaron", "form-submitted note"]);
    seed.close();

    const r = await $`bun ${cli} feedback --db ${path} --project arc-webui --body ${"agent friction"} --context ${"/board"} --task ${"t-1"}`.quiet();
    const res = JSON.parse(r.stdout.toString());
    expect(res.logged).toBe(true);

    const db = new Database(path);
    // pre-existing channel-source row survives untouched (no CHECK rejects 'direct')
    const web = db.query<{ source: string; submitter: string }, [string]>(
      "SELECT source, submitter FROM feedback WHERE id=?").get("web-1")!;
    const agent = db.query<{ context: string; origin_task_id: string; source: string }, [string]>(
      "SELECT context, origin_task_id, source FROM feedback WHERE id=?").get(res.id)!;
    db.close();
    expect(web.source).toBe("direct");
    expect(web.submitter).toBe("aaron");
    expect(agent.context).toBe("/board");
    expect(agent.origin_task_id).toBe("t-1");
    expect(agent.source).toBe("ai-agent");
  } finally {
    cleanup();
  }
});

test("--project and --body are required", async () => {
  const { path, cleanup } = freshDb();
  try {
    const noProj = await $`bun ${cli} feedback --db ${path} --body ${"x"}`.quiet().nothrow();
    expect(noProj.exitCode).not.toBe(0);
    const noBody = await $`bun ${cli} feedback --db ${path} --project arc-webui`.quiet().nothrow();
    expect(noBody.exitCode).not.toBe(0);
  } finally {
    cleanup();
  }
});
