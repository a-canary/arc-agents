import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate, mintId } from "./db";
import { detectCrossRepoTarget, sweepCrossRepoGate } from "./cross-repo-gate";

function freshDb(): { db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "crg-test-"));
  const db = openWithMigrate(join(dir, "t.db"));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function insertReady(db: Database, project: string, title: string, body: string): string {
  const id = mintId(db, title);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES (?, ?, ?, ?, '', 'mvp', 'ready', 'task', 'mvp', 'explore')`,
    [id, project, title, body],
  );
  return id;
}

// --- detector ---

test("Pattern A recurrence shape: arc-agents row targeting a-canary/cli-proxy fires", () => {
  expect(
    detectCrossRepoTarget("arc-agents", "surface proxy tradeoffs", "work only implementable in a-canary/cli-proxy"),
  ).toBe("cli-proxy");
});

test("own-repo mention anywhere suppresses the gate", () => {
  expect(
    detectCrossRepoTarget("arc-agents", "routing fix", "gate lives in a-canary/arc-agents, observed via a-canary/cli-proxy rows"),
  ).toBeNull();
});

test("no repo slug mentioned → null", () => {
  expect(detectCrossRepoTarget("arc-agents", "fix bin/ledger.ts", "plain body")).toBeNull();
});

test("ambiguous multi-repo mention → null", () => {
  expect(
    detectCrossRepoTarget("arc-agents", "t", "touches a-canary/cli-proxy and a-canary/ke"),
  ).toBeNull();
});

test("unknown slug → null; case-insensitive known slug fires", () => {
  expect(detectCrossRepoTarget("arc-agents", "t", "see a-canary/some-unknown-repo")).toBeNull();
  expect(detectCrossRepoTarget("arc-agents", "t", "PR to a-canary/Trading please")).toBe("trading");
});

test("null project / null body → null", () => {
  expect(detectCrossRepoTarget(null, "t", "a-canary/ke")).toBeNull();
  expect(detectCrossRepoTarget("arc-agents", "t", null)).toBeNull();
});

test("the motivating incident: arc-agents row requiring work in a-canary/webui fires", () => {
  expect(
    detectCrossRepoTarget(
      "arc-agents",
      "webui-arc-context-proxy-tradeoff-surface",
      "required work only implementable in a-canary/webui",
    ),
  ).toBe("arc-webui");
});

// --- sweep ---

test("sweep parks a flagged ready row hitl=1 with a note event, skips clean rows", () => {
  const { db, cleanup } = freshDb();
  try {
    const bad = insertReady(db, "arc-agents", "wrong-home row", "fix must land in a-canary/ke");
    const ok = insertReady(db, "arc-agents", "fine row", "edit src/ledger/claim.ts");
    const parked = sweepCrossRepoGate(db);
    expect(parked).toEqual([{ id: bad, project: "arc-agents", target: "ke" }]);
    const row = db.query<{ hitl: number; state: string }, [string]>("SELECT hitl, state FROM issues WHERE id=?").get(bad)!;
    expect(row.hitl).toBe(1);
    expect(row.state).toBe("ready");
    const okRow = db.query<{ hitl: number }, [string]>("SELECT hitl FROM issues WHERE id=?").get(ok)!;
    expect(okRow.hitl).toBe(0);
    const ev = db.query("SELECT 1 FROM issue_events WHERE issue_id=? AND agent='cross-repo-gate'").get(bad);
    expect(ev).not.toBeNull();
  } finally { cleanup(); }
});

test("opus unpark is final: sweep never re-parks a row with a cross-repo-gate event", () => {
  const { db, cleanup } = freshDb();
  try {
    const bad = insertReady(db, "arc-agents", "wrong-home row", "fix must land in a-canary/ke");
    expect(sweepCrossRepoGate(db).length).toBe(1);
    // gate-triage lifts the park
    db.run("UPDATE issues SET hitl=0 WHERE id=?", [bad]);
    expect(sweepCrossRepoGate(db).length).toBe(0);
    expect(db.query<{ hitl: number }, [string]>("SELECT hitl FROM issues WHERE id=?").get(bad)!.hitl).toBe(0);
  } finally { cleanup(); }
});

// --- title-prefix detection (motivating row shape: no slug anywhere) ---

test("motivating row shape: 'webui: ...' title on an arc-agents row fires", () => {
  expect(
    detectCrossRepoTarget(
      "arc-agents",
      "webui: arc-context-proxy tradeoff surface — admissibility frontier",
      "Clause (c): 'tradeoffs are illustrated on webui'. RENDER from metrics.jsonl.",
    ),
  ).toBe("arc-webui");
});

test("hygiene-skill title prefix is not a project → null", () => {
  expect(
    detectCrossRepoTarget("arc-agents", "improve-architecture: gate claim on row project", "body"),
  ).toBeNull();
});

test("own-project title prefix → null", () => {
  expect(detectCrossRepoTarget("arc-agents", "arc-agents: fix claim SQL", "body")).toBeNull();
});

test("title prefix naming own repo basename → null", () => {
  expect(detectCrossRepoTarget("arc-webui", "webui: fix chat pane", "body")).toBeNull();
});

test("own-repo slug in body still suppresses a foreign title prefix", () => {
  expect(
    detectCrossRepoTarget("arc-agents", "webui: surface metrics", "gate lives in a-canary/arc-agents"),
  ).toBeNull();
});

test("ambiguous multi-repo body still wins over title prefix (null)", () => {
  expect(
    detectCrossRepoTarget("arc-agents", "webui: x", "touches a-canary/ke and a-canary/pipeliner"),
  ).toBeNull();
});

test("sweep parks a title-prefix-only mis-routed row", () => {
  const { db, cleanup } = freshDb();
  try {
    const id = insertReady(db, "arc-agents", "webui: render the tradeoff surface", "no slug here");
    const parked = sweepCrossRepoGate(db);
    expect(parked.map((p) => p.id)).toContain(id);
    expect(db.query<{ hitl: number }, [string]>("SELECT hitl FROM issues WHERE id=?").get(id)?.hitl).toBe(1);
  } finally {
    cleanup();
  }
});
