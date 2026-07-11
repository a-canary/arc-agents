// Tests for project-slug dedupe (phase 1 cleanup per PRD
// dedupe-project-slugs-in-ledger-trading-c).
//
// Phase 1 normalises 5 known dupe families — Trading/conjecture/Conjecture →
// lower-case, plus webui → arc-webui. The function MUST be idempotent: running
// twice on the same DB must change row counts zero the second time, and the
// final state must match the canonical lower-case (or arc-webui for the
// prefix-migration family).
//
// All DBs here are throwaway in-memory. The production invocation against
// ~/vault/ledger.db lives in bin/dedupe-project-slugs.ts.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { dedupeProjectSlugs } from "./project-slugs";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function insertIssue(db: Database, id: string, project: string): void {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES (?, ?, ?, '', 'mvp', 'ready', 'task')`,
    [id, project, `t-${id}`],
  );
}

test("project-slugs: lower-cases Trading/Conjecture/Starlight-SLM/OurNation/onenation", () => {
  const db = fresh();
  insertIssue(db, "a", "Trading");
  insertIssue(db, "b", "trading");
  insertIssue(db, "c", "Conjecture");
  insertIssue(db, "d", "conjecture");
  insertIssue(db, "e", "Starlight-SLM");
  insertIssue(db, "f", "starlight-slm");
  insertIssue(db, "g", "OurNation");
  insertIssue(db, "h", "onenation");

  const r = dedupeProjectSlugs(db);
  // 4 mixed-case rows affected (Trading, Conjecture, Starlight-SLM, OurNation).
  // The lower-case variants (trading/conjecture/starlight-slm/onenation) are
  // already canonical and untouched.
  expect(r.affected).toBe(4);

  const rows = db
    .query<{ project: string; n: number }, []>(
      "SELECT project, COUNT(*) AS n FROM issues GROUP BY project ORDER BY project",
    )
    .all();
  // No mixed-case survivors.
  expect(rows.find((x) => x.project === "Trading")).toBeUndefined();
  expect(rows.find((x) => x.project === "Conjecture")).toBeUndefined();
  expect(rows.find((x) => x.project === "Starlight-SLM")).toBeUndefined();
  expect(rows.find((x) => x.project === "OurNation")).toBeUndefined();
  // All four families collapse to lower-case.
  const map = new Map(rows.map((x) => [x.project, x.n]));
  expect(map.get("trading")).toBe(2);
  expect(map.get("conjecture")).toBe(2);
  expect(map.get("starlight-slm")).toBe(2);
  expect(map.get("onenation")).toBe(2);
});

test("project-slugs: webui → arc-webui (prefix migration)", () => {
  const db = fresh();
  insertIssue(db, "x1", "webui");
  insertIssue(db, "x2", "arc-webui");
  insertIssue(db, "x3", "webui");

  const r = dedupeProjectSlugs(db);
  // webui rows flip; arc-webui is already canonical.
  expect(r.affected).toBe(2);

  const survivors = db
    .query<{ project: string }, []>(
      "SELECT DISTINCT project FROM issues WHERE project IN ('webui','arc-webui')",
    )
    .all()
    .map((x) => x.project);
  expect(survivors).toEqual(["arc-webui"]);
});

test("project-slugs: idempotent — second run affects 0 rows", () => {
  const db = fresh();
  insertIssue(db, "i1", "Trading");
  insertIssue(db, "i2", "Conjecture");
  insertIssue(db, "i3", "Starlight-SLM");
  insertIssue(db, "i4", "OurNation");
  insertIssue(db, "i5", "webui");

  const first = dedupeProjectSlugs(db);
  expect(first.affected).toBe(5);

  const second = dedupeProjectSlugs(db);
  expect(second.affected).toBe(0);

  const distinctCount = db
    .query<{ n: number }, []>("SELECT COUNT(DISTINCT project) AS n FROM issues")
    .get();
  // 5 unique projects remain — one per family.
  expect(distinctCount?.n).toBe(5);
});

test("project-slugs: leaves unrelated projects untouched", () => {
  const db = fresh();
  insertIssue(db, "u1", "arc-agents");
  insertIssue(db, "u2", "Trading"); // in-scope, should flip
  insertIssue(db, "u3", "pi-mono");
  insertIssue(db, "u4", "vault");

  dedupeProjectSlugs(db);

  const untouched = db
    .query<{ project: string }, []>(
      "SELECT project FROM issues WHERE id IN ('u1','u3','u4') ORDER BY id",
    )
    .all()
    .map((x) => x.project);
  expect(untouched).toEqual(["arc-agents", "pi-mono", "vault"]);
});

test("project-slugs: empty DB returns affected=0, no throw", () => {
  const db = fresh();
  const r = dedupeProjectSlugs(db);
  expect(r.affected).toBe(0);
});

test("project-slugs: distinct project count drops by 5 on a full mixed DB", () => {
  const db = fresh();
  // 5 dupe families × 2 case variants each = 10 in-scope rows.
  // Plus 3 unrelated rows → 13 rows, 13 distinct projects initially.
  insertIssue(db, "m1", "Trading");
  insertIssue(db, "m2", "trading");
  insertIssue(db, "m3", "Conjecture");
  insertIssue(db, "m4", "conjecture");
  insertIssue(db, "m5", "Starlight-SLM");
  insertIssue(db, "m6", "starlight-slm");
  insertIssue(db, "m7", "OurNation");
  insertIssue(db, "m8", "onenation");
  insertIssue(db, "m9", "webui");
  insertIssue(db, "m10", "arc-webui");
  insertIssue(db, "m11", "arc-agents");
  insertIssue(db, "m12", "pi-mono");
  insertIssue(db, "m13", "vault");

  const before = db
    .query<{ n: number }, []>("SELECT COUNT(DISTINCT project) AS n FROM issues")
    .get();
  expect(before?.n).toBe(13);

  dedupeProjectSlugs(db);

  const after = db
    .query<{ n: number }, []>("SELECT COUNT(DISTINCT project) AS n FROM issues")
    .get();
  // 5 families collapse (Trading, Conjecture, Starlight-SLM, OurNation, webui)
  // → 13 - 5 = 8 distinct projects.
  expect(after?.n).toBe(8);
});
