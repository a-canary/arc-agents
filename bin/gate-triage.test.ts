import { describe, expect, test } from "bun:test";
import { parseVerdict, stamp } from "./gate-triage";

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
import { SELECT_SQL } from "./gate-triage";

test("selection: prds always, tasks only when review-stale >48h", () => {
  const db = new Database(":memory:");
  db.run("create table issues (id text, title text, body_md text, kind text, state text, updated_at integer, hitl integer default 0)");
  const now = Math.floor(Date.now() / 1000);
  const ins = db.query("insert into issues values (?,?,?,?,?,?,?)");
  ins.run("p1", "prd fresh", "", "prd", "review", now, 0);
  ins.run("t-old", "task stale", "", "task", "review", now - 3 * 86400, 0);
  ins.run("t-new", "task fresh", "", "task", "review", now - 3600, 0);
  ins.run("t-done", "task merged", "", "task", "merged", now - 9 * 86400, 0);
  ins.run("p-stamped", "prd stamped", "<!-- gate-triage -->", "prd", "review", now, 0);
  ins.run("t-parked-stale", "ready hitl park stale", "", "task", "ready", now - 3 * 3600, 1);
  ins.run("t-parked-fresh", "ready hitl park fresh", "", "task", "ready", now - 600, 1);
  ins.run("t-ready-plain", "ready unparked", "", "task", "ready", now - 3 * 3600, 0);
  const ids = (db.query(SELECT_SQL).all("<!-- gate-triage -->") as Array<{ id: string }>).map((r) => r.id).sort();
  expect(ids).toEqual(["p1", "t-old", "t-parked-stale"]);
});

import { hasSalvageableCommits } from "./gate-triage";

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
