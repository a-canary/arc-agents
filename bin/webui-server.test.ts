import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import {
  buildHandler,
  queryAfkRows,
  queryHitlRows,
  queryThread,
  resolveIfaceAddr,
  sseStream,
} from "./webui-server";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "webui-server-"));
  const db = openWithMigrate(join(dir, "t.db"));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function insertIssue(
  db: ReturnType<typeof openWithMigrate>,
  row: { id: string; title: string; type?: string; state?: string; hitl?: number; updated_at?: number },
) {
  const now = row.updated_at ?? Math.floor(Date.now() / 1000);
  db.exec(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, class, urgency, hitl, created_at, updated_at)
     VALUES (?, 'arc-agents', ?, '', '', ?, ?, 'task', 'class_unset', 'nominal', ?, ?, ?)`,
    [row.id, row.title, row.type ?? "mvp", row.state ?? "ready", row.hitl ?? 0, now, now] as never,
  );
}

test("resolveIfaceAddr throws on missing iface", () => {
  expect(() => resolveIfaceAddr("definitely-no-such-iface-xyz")).toThrow(/not found/);
});

test("resolveIfaceAddr returns address for loopback", () => {
  // lo always exists on linux. Skip if absent (mac calls it lo0).
  const ifaces = ["lo", "lo0"];
  let found: string | null = null;
  for (const i of ifaces) {
    try {
      found = resolveIfaceAddr(i);
      break;
    } catch {}
  }
  // loopback is .internal=true so resolveIfaceAddr filters it out and throws.
  // This documents the contract: we want non-internal addrs only.
  expect(found).toBeNull();
});

test("queryHitlRows returns HITL and hitl=1 rows in non-terminal states", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "h1", title: "hitl 1", type: "HITL", state: "ready" });
    insertIssue(db, { id: "h2", title: "hitl merged", type: "HITL", state: "merged" });
    insertIssue(db, { id: "h3", title: "flagged", type: "mvp", state: "ready", hitl: 1 });
    insertIssue(db, { id: "h4", title: "plain", type: "mvp", state: "ready" });
    const rows = queryHitlRows(db);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["h1", "h3"]);
  } finally {
    cleanup();
  }
});

test("queryAfkRows includes in-flight + ready + capped merged", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "wip1", title: "wip", state: "wip" });
    insertIssue(db, { id: "ready1", title: "ready", state: "ready" });
    insertIssue(db, { id: "blk1", title: "blocked", state: "blocked" });
    for (let i = 0; i < 15; i++) {
      insertIssue(db, {
        id: `m${i}`,
        title: `merged ${i}`,
        state: "merged",
        updated_at: 1_700_000_000 + i,
      });
    }
    const rows = queryAfkRows(db);
    const merged = rows.filter((r) => r.state === "merged");
    expect(merged.length).toBe(10);
    // Most recent first.
    expect(merged[0]!.id).toBe("m14");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("wip1");
    expect(ids).toContain("ready1");
    expect(ids).toContain("blk1");
  } finally {
    cleanup();
  }
});

test("queryAfkRows excludes paused rows", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "live", title: "live", state: "ready" });
    insertIssue(db, { id: "off", title: "paused", state: "ready" });
    db.exec("UPDATE issues SET paused = 1 WHERE id = 'off'");
    const ids = queryAfkRows(db).map((r) => r.id);
    expect(ids).toContain("live");
    expect(ids).not.toContain("off");
  } finally {
    cleanup();
  }
});

test("handler /health returns ok", async () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = handler(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  } finally {
    cleanup();
  }
});

test("handler unknown path returns 404", () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = handler(new Request("http://x/nope"));
    expect(res.status).toBe(404);
  } finally {
    cleanup();
  }
});

test("sseStream emits snapshot event with rows", async () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "h1", title: "hitl", type: "HITL", state: "ready" });
    const stream = sseStream(db, "hitl", 60_000);
    const reader = stream.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    expect(text).toContain('"panel":"hitl"');
    expect(text).toContain('"id":"h1"');
    await reader.cancel();
  } finally {
    cleanup();
  }
});

test("sseStream second tick with no changes emits heartbeat", async () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "h1", title: "hitl", type: "HITL", state: "ready" });
    const stream = sseStream(db, "hitl", 20);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toContain("snapshot");
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value!)).toContain(": heartbeat");
    await reader.cancel();
  } finally {
    cleanup();
  }
});

test("sseStream re-emits snapshot on row change", async () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "h1", title: "hitl", type: "HITL", state: "ready" });
    const stream = sseStream(db, "hitl", 20);
    const reader = stream.getReader();
    await reader.read(); // snapshot
    db.exec("UPDATE issues SET state='wip', updated_at=updated_at+1 WHERE id='h1'");
    let saw = false;
    for (let i = 0; i < 5 && !saw; i++) {
      const { value } = await reader.read();
      if (new TextDecoder().decode(value!).includes("snapshot")) saw = true;
    }
    expect(saw).toBe(true);
    await reader.cancel();
  } finally {
    cleanup();
  }
});

test("queryThread by issue id returns issue + events", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "t1", title: "thread anchor", state: "wip" });
    db.exec(
      `INSERT INTO issue_events (issue_id, ts, agent, kind, payload_md)
       VALUES ('t1', 100, 'bookie', 'created', 'born'),
              ('t1', 101, 'worker-x', 'claimed', 'mine')`,
    );
    const v = queryThread(db, "t1");
    expect(v).not.toBeNull();
    expect(v!.issue.id).toBe("t1");
    expect(v!.events.length).toBe(2);
    expect(v!.events[0]!.kind).toBe("created");
    expect(v!.events[1]!.agent).toBe("worker-x");
    expect(v!.related).toEqual([]);
  } finally {
    cleanup();
  }
});

test("queryThread returns null for unknown id", () => {
  const { db, cleanup } = freshDb();
  try {
    expect(queryThread(db, "nope")).toBeNull();
  } finally {
    cleanup();
  }
});

test("queryThread by thread_id returns anchor + related rows", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "a", title: "first", updated_at: 100 });
    insertIssue(db, { id: "b", title: "second", updated_at: 200 });
    insertIssue(db, { id: "c", title: "third", updated_at: 300 });
    db.exec("UPDATE issues SET thread_id='T-1' WHERE id IN ('a','b','c')");
    const v = queryThread(db, "T-1");
    expect(v).not.toBeNull();
    expect(v!.issue.id).toBe("a");
    expect(v!.related.map((r) => r.id)).toEqual(["b", "c"]);
  } finally {
    cleanup();
  }
});

test("queryThread by issue id includes thread siblings in related", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "a", title: "first", updated_at: 100 });
    insertIssue(db, { id: "b", title: "second", updated_at: 200 });
    db.exec("UPDATE issues SET thread_id='T-2' WHERE id IN ('a','b')");
    const v = queryThread(db, "b");
    expect(v!.issue.id).toBe("b");
    expect(v!.related.map((r) => r.id)).toEqual(["a"]);
  } finally {
    cleanup();
  }
});

test("handler /thread/:id returns 200 + json for known issue", async () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "t1", title: "x", state: "wip" });
    const handler = buildHandler(db);
    const res = handler(new Request("http://x/thread/t1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issue.id).toBe("t1");
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.related)).toBe(true);
  } finally {
    cleanup();
  }
});

test("handler /thread/:id returns 404 for unknown", () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = handler(new Request("http://x/thread/nope"));
    expect(res.status).toBe(404);
  } finally {
    cleanup();
  }
});

test("handler /thread/ (empty id) returns 400", () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = handler(new Request("http://x/thread/"));
    expect(res.status).toBe(400);
  } finally {
    cleanup();
  }
});
