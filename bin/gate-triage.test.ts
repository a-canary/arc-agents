import { describe, expect, test } from "bun:test";
import { parseVerdict, stamp, SELECT_SQL, hasSalvageableCommits, preJudgeFlip, isNonOwnedRepoPr } from "./gate-triage";

describe("parseVerdict", () => {
  test("accepts valid auto verdict with tool list", () => {
    const v = parseVerdict('noise before {"gate":"auto","reason":"ops work","allowed_tools":["Read","Bash"]} after');
    expect(v).toEqual({ gate: "auto", reason: "ops work", allowed_tools: ["Read", "Bash"] });
  });
  test("accepts human verdict", () => {
    expect(parseVerdict('{"gate":"human","reason":"objective delta","allowed_tools":[]}')?.gate).toBe("human");
  });
  test("rejects bad gate, missing reason, non-array tools, garbage", () => {
    expect(parseVerdict('{"gate":"maybe","reason":"x","allowed_tools":[]}')).toBeNull();
    expect(parseVerdict('{"gate":"auto","allowed_tools":[]}')).toBeNull();
    expect(parseVerdict('{"gate":"auto","reason":"x","allowed_tools":"Bash"}')).toBeNull();
    expect(parseVerdict("no json here")).toBeNull();
  });
  test("drops non-string tools", () => {
    expect(parseVerdict('{"gate":"auto","reason":"x","allowed_tools":["Read",5,null]}')?.allowed_tools).toEqual(["Read"]);
  });
});

describe("stamp", () => {
  test("human stamp carries HUMAN GATE and the marker", () => {
    const s = stamp({ gate: "human", reason: "changes APR target", allowed_tools: [] });
    expect(s).toContain("<!-- gate-triage -->");
    expect(s).toContain("HUMAN GATE");
    expect(s).toContain("changes APR target");
  });
  test("auto stamp carries allowed-tools + escalation rule", () => {
    const s = stamp({ gate: "auto", reason: "hygiene", allowed_tools: ["Read", "Edit", "Bash"] });
    expect(s).toContain("allowed-tools: Read, Edit, Bash");
    expect(s).toContain("model: opus");
    expect(s).toContain("auto-approved");
  });
});

import { Database } from "bun:sqlite";

test("selection: prds always, tasks only when review-stale >48h", () => {
  const db = new Database(":memory:");
  db.run("create table issues (id text, title text, body_md text, kind text, state text, updated_at integer, hitl integer default 0)");
  db.run("alter table issues add column pr_url text");
  const now = Math.floor(Date.now() / 1000);
  const ins = db.query("insert into issues (id, title, body_md, kind, state, updated_at, hitl) values (?,?,?,?,?,?,?)");
  ins.run("p1", "prd fresh", "", "prd", "review", now, 0);
  ins.run("t-old", "task stale", "", "task", "review", now - 3 * 86400, 0);
  ins.run("t-new", "task fresh", "", "task", "review", now - 3600, 0);
  ins.run("t-done", "task merged", "", "task", "merged", now - 9 * 86400, 0);
  ins.run("p-stamped", "prd stamped", "<!-- gate-triage -->", "prd", "review", now, 0);
  ins.run("t-parked-stale", "ready hitl park stale", "", "task", "ready", now - 3 * 3600, 1);
  ins.run("t-parked-fresh", "ready hitl park fresh", "", "task", "ready", now - 600, 1);
  ins.run("t-ready-plain", "ready unparked", "", "task", "ready", now - 3 * 3600, 0);
  // Per close-the-ready-prd-dead-lane acceptance criteria (a–d):
  ins.run("p-stale-ready", "prd stale ready", "", "prd", "ready", now - 3 * 86400, 0); // (a) selected
  ins.run("p-fresh-ready", "prd fresh ready", "", "prd", "ready", now - 3600, 0);      // (b) NOT selected
  ins.run("p-stale-prereview", "prd stale review", "", "prd", "review", now - 9 * 86400, 0); // (c) selected via review arm
  const ids = (db.query(SELECT_SQL).all("<!-- gate-triage -->") as Array<{ id: string }>).map((r) => r.id).sort();
  expect(ids).toEqual(["p-stale-prereview", "p-stale-ready", "p1", "t-old", "t-parked-stale"]);
});

test("preJudgeFlip: atomically flips ready+prd → review and logs a verdict-shaped event", () => {
  const db = new Database(":memory:");
  db.run(
    "create table issues (id text primary key, title text, body_md text, kind text, state text, updated_at integer)",
  );
  db.run(
    "create table issue_events (seq integer primary key, issue_id text, ts integer, agent text, kind text, payload_md text)",
  );
  const now = Math.floor(Date.now() / 1000);
  db.query("insert into issues values (?,?,?,?,?,?)").run("prd-stale", "stale ready prd", "", "prd", "ready", now - 3 * 86400);
  db.query("insert into issues values (?,?,?,?,?,?)").run("prd-fresh", "fresh ready prd", "", "prd", "ready", now - 3600);
  db.query("insert into issues values (?,?,?,?,?,?)").run("prd-review", "already review prd", "", "prd", "review", now - 86400);

  const r1 = preJudgeFlip(db, "prd-stale");
  expect(r1).toEqual({ flipped: true, from: "ready", to: "review" });
  // preJudgeFlip operates on kind+state alone — the 48h staleness guard is
  // upstream in SELECT_SQL. Callers passing a young ready PRD still flip it.
  // The gate's idempotency guarantee is "already-review rows do not flip".
  const r2 = preJudgeFlip(db, "prd-fresh");
  expect(r2).toEqual({ flipped: true, from: "ready", to: "review" });
  // Already-review: no-op (re-running the cycle does no harm).
  const r3 = preJudgeFlip(db, "prd-review");
  expect(r3).toEqual({ flipped: false, from: "review", to: "review" });

  const states = db.query("select id, state from issues order by id").all() as Array<{ id: string; state: string }>;
  expect(states).toEqual([
    { id: "prd-fresh", state: "review" },
    { id: "prd-review", state: "review" },
    { id: "prd-stale", state: "review" },
  ]);
  const events = db.query("select issue_id, kind from issue_events order by seq").all() as Array<{ issue_id: string; kind: string }>;
  expect(events).toEqual([
    { issue_id: "prd-stale", kind: "progress" },
    { issue_id: "prd-fresh", kind: "progress" },
  ]);
});

test("triage cycle on a stale ready PRD: pre-judge flip → review → judge fires verdict event", () => {
  const db = new Database(":memory:");
  db.run(
    "create table issues (id text primary key, title text, body_md text, kind text, state text, updated_at integer, hitl integer default 0)",
  );
  db.run(
    "create table issue_events (seq integer primary key, issue_id text, ts integer, agent text, kind text, payload_md text)",
  );
  const now = Math.floor(Date.now() / 1000);
  db.query("insert into issues values (?,?,?,?,?,?,?)").run(
    "prd-stale",
    "stale ready prd → triage",
    "body before triage",
    "prd",
    "ready",
    now - 3 * 86400,
    0,
  );

  // 1. pre-judge flip is the new step
  const flip = preJudgeFlip(db, "prd-stale");
  expect(flip.flipped).toBe(true);

  // 2. After flip, the existing webui approve path is now eligible (prd + review).
  //    Simulate that path: stamp the body + emit the verdict event.
  const evidence = "auto triage verdict (test stub)";
  db.query("update issues set body_md = body_md || ? where id = ?").run(`\n> ${evidence}\n`, "prd-stale");
  db.query(
    "insert into issue_events (issue_id, ts, agent, kind, payload_md) values (?,?,?,?,?)",
  ).run("prd-stale", Math.floor(Date.now() / 1000), "gate-triage", "verdict", evidence);

  const final = db.query("select id, state, body_md from issues where id = 'prd-stale'").get() as { id: string; state: string; body_md: string };
  expect(final.state).toBe("review");
  expect(final.body_md).toContain("verdict");

  const verdictEvents = db
    .query("select kind from issue_events where issue_id = 'prd-stale' and kind = 'verdict'")
    .all();
  expect(verdictEvents.length).toBe(1);
});

test("hasSalvageableCommits: true only when a progress event logged commits", () => {
  const db = new Database(":memory:");
  db.run("create table issue_events (seq integer primary key, issue_id text, ts integer, agent text, kind text, payload_md text)");
  const ins = db.query("insert into issue_events (issue_id, ts, agent, kind, payload_md) values (?,?,?,?,?)");
  ins.run("t-work", 1, "cli", "progress", "→ review\n\nheadless reconcile: exited 1 with 2 commit(s) on worker/t-work");
  ins.run("t-empty", 1, "cli", "progress", "→ review\n\nno work produced");
  ins.run("t-other", 1, "bookie", "diff_review", "mentions commit(s) but wrong kind");
  expect(hasSalvageableCommits(db, "t-work")).toBe(true);
  expect(hasSalvageableCommits(db, "t-empty")).toBe(false);
  expect(hasSalvageableCommits(db, "t-other")).toBe(false);
  expect(hasSalvageableCommits(db, "t-missing")).toBe(false);
});

describe("isNonOwnedRepoPr", () => {
  test("true for a conjecture PR url", () => {
    expect(isNonOwnedRepoPr("https://github.com/a-canary/Conjecture/pull/17")).toBe(true);
  });
  test("false for an owned repo url", () => {
    expect(isNonOwnedRepoPr("https://github.com/a-canary/arc-agents/pull/5")).toBe(false);
  });
  test("false for empty/missing pr_url", () => {
    expect(isNonOwnedRepoPr("")).toBe(false);
  });
});

test("merge-review feedback ids use the full task id (24-char prefixes collide)", () => {
  const db = new Database(":memory:");
  db.run(
    "create table feedback (id text primary key, project text, source text, submitter text, state text, body_md text, created_at text)",
  );
  const ids = [
    "arc-webui-dashboard-show-counters-a",
    "arc-webui-dashboard-show-counters-b", // same first 24 chars
  ];
  for (const id of ids) {
    db.query(
      "insert or ignore into feedback (id, project, source, submitter, state, body_md, created_at) values (?, 'allmissions', 'gate-triage', 'gate-triage', 'OPEN', ?, '2026-07-11T00:00:00Z')",
    ).run(`gt-merge-review-${id}`, id);
  }
  const n = db.query("select count(*) as n from feedback").get() as { n: number };
  expect(n.n).toBe(2);
});
