import { test, expect } from "bun:test";
import { $ } from "bun";
import { openWithMigrate } from "../src/ledger/db";
import { unlinkSync, existsSync } from "node:fs";

const NOW = Math.floor(Date.now() / 1000);

function insertTask(
  db: ReturnType<typeof openWithMigrate>,
  id: string,
  state: string,
  evidence: string,
  project = "demo",
) {
  db.run(
    "INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, created_at, evidence_md) VALUES (?,?,?,'','','mvp',?,'task','mvp','build','agent_unset',?,?)",
    [id, project, `Task ${id}`, state, NOW, evidence],
  );
}

function cleanup(dbPath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
}

test("converts pre-fix failed no-work rows to blocked with marker, idempotent, leaves decoys alone", async () => {
  const dbPath = `/tmp/backfill-f2b-${Date.now()}-a.db`;
  const db = openWithMigrate(dbPath);

  // Pre-fix failed rows (the targets): two aliases, distinct rc values.
  insertTask(db, "f-pre-1", "failed", "headless reconcile: all 2 candidate engine(s) for alias 'minimax-build' produced no work (last rc=141); marked failed.");
  insertTask(db, "f-pre-2", "failed", "headless reconcile: all 2 candidate engine(s) for alias 'minimax-build' produced no work (last rc=0); marked failed.");
  insertTask(db, "f-pre-3", "failed", "headless reconcile: all 2 candidate engine(s) for alias 'fast' produced no work (last rc=1); marked failed.");

  // Post-fix already-blocked row (post-d1f9ae3 shape) — must NOT be touched.
  insertTask(db, "f-post", "blocked", "headless reconcile: all 2 candidate engine(s) for alias 'minimax-build' produced no work (last rc=141); engine-alias-no-work:minimax-build");

  // Decoy failed rows: nothing to do with the no-work signature.
  insertTask(db, "f-decoy-1", "failed", "task body: completed 0 of 5 acceptance criteria; marked failed.");
  insertTask(db, "f-decoy-2", "failed", "headless reconcile: timeout in candidate 1 of 3 for alias 'minimax-build'; marked failed.");
  // Decoy with "produced no work" but wrong suffix — passes the LIKE, fails the regex.
  insertTask(db, "f-decoy-3", "failed", "headless reconcile: all 2 candidate engine(s) for alias 'minimax-build' produced no work (last rc=141); something else.");

  db.close();

  // First run — convert the 3 pre-fix rows, leave the post-fix blocked + 3 decoys.
  const r1 = await $`bun ${import.meta.dir}/backfill-failed-to-blocked.ts ${dbPath}`.json();
  // SQL LIKE filter selects all 4 (3 pre-fix + decoy-3); decoy-1/2 don't match LIKE.
  expect(r1.total).toBe(4);
  // decoy-3 passes LIKE but fails the strict PRE_FIX_RE (suffix doesn't match).
  expect(r1.converted).toBe(3);
  expect(r1.skipped).toBe(1);
  expect(r1.byAlias).toEqual({ "minimax-build": 2, fast: 1 });

  const check1 = openWithMigrate(dbPath);
  const pre1 = check1.query<{ state: string; evidence_md: string }, [string]>("SELECT state, evidence_md FROM issues WHERE id=?").get("f-pre-1");
  expect(pre1!.state).toBe("blocked");
  expect(pre1!.evidence_md).toBe("headless reconcile: all 2 candidate engine(s) for alias 'minimax-build' produced no work (last rc=141); engine-alias-no-work:minimax-build");

  const pre3 = check1.query<{ state: string; evidence_md: string }, [string]>("SELECT state, evidence_md FROM issues WHERE id=?").get("f-pre-3");
  expect(pre3!.state).toBe("blocked");
  expect(pre3!.evidence_md).toBe("headless reconcile: all 2 candidate engine(s) for alias 'fast' produced no work (last rc=1); engine-alias-no-work:fast");

  // Post-fix blocked untouched.
  const post = check1.query<{ state: string; evidence_md: string }, [string]>("SELECT state, evidence_md FROM issues WHERE id=?").get("f-post");
  expect(post!.state).toBe("blocked");
  expect(post!.evidence_md).toBe("headless reconcile: all 2 candidate engine(s) for alias 'minimax-build' produced no work (last rc=141); engine-alias-no-work:minimax-build");

  // Decoy failed rows untouched — state still failed, evidence unchanged.
  const decoy1 = check1.query<{ state: string; evidence_md: string }, [string]>("SELECT state, evidence_md FROM issues WHERE id=?").get("f-decoy-1");
  expect(decoy1!.state).toBe("failed");
  expect(decoy1!.evidence_md).toBe("task body: completed 0 of 5 acceptance criteria; marked failed.");

  const decoy2 = check1.query<{ state: string; evidence_md: string }, [string]>("SELECT state, evidence_md FROM issues WHERE id=?").get("f-decoy-2");
  expect(decoy2!.state).toBe("failed");
  expect(decoy2!.evidence_md).toBe("headless reconcile: timeout in candidate 1 of 3 for alias 'minimax-build'; marked failed.");

  // One `note` event per converted row.
  const notes = check1.query<{ issue_id: string; payload_md: string }, []>("SELECT issue_id, payload_md FROM issue_events WHERE kind='note' ORDER BY issue_id").all();
  expect(notes.length).toBe(3);
  expect(notes.map((n) => n.issue_id).sort()).toEqual(["f-pre-1", "f-pre-2", "f-pre-3"]);
  expect(notes[0]!.payload_md).toContain("alias=");

  check1.close();

  // Second run — idempotent. The previously-converted rows are now in `blocked`,
  // so the SQL filter (state='failed') excludes them. Decoy-3 still in failed
  // but skipped by the regex (non-conforming suffix). Total = 1, converted = 0.
  const r2 = await $`bun ${import.meta.dir}/backfill-failed-to-blocked.ts ${dbPath}`.json();
  expect(r2.total).toBe(1);
  expect(r2.converted).toBe(0);
  expect(r2.skipped).toBe(1);
  expect(r2.byAlias).toEqual({});

  cleanup(dbPath);
});

test("empty ledger: total=0, converted=0, skipped=0", async () => {
  const dbPath = `/tmp/backfill-f2b-${Date.now()}-b.db`;
  const db = openWithMigrate(dbPath);
  db.run("INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, created_at) VALUES ('unrelated','demo','Other','','','mvp','failed','task','mvp','build','agent_unset',?)", [NOW]);
  db.close();

  const r = await $`bun ${import.meta.dir}/backfill-failed-to-blocked.ts ${dbPath}`.json();
  expect(r).toEqual({ total: 0, converted: 0, skipped: 0, byAlias: {} });

  const check = openWithMigrate(dbPath);
  const row = check.query<{ state: string }, [string]>("SELECT state FROM issues WHERE id=?").get("unrelated");
  expect(row!.state).toBe("failed");
  check.close();
  cleanup(dbPath);
});