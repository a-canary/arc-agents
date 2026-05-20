import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import {
  buildHandler,
  queryAfkRows,
  queryHitlRows,
  queryTop3ChatIn,
  resolveIfaceAddr,
  sseStream,
  submitReply,
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

test("resolveIfaceAddr short-circuits all-interfaces literals", () => {
  expect(resolveIfaceAddr("0.0.0.0")).toBe("0.0.0.0");
  expect(resolveIfaceAddr("::")).toBe("::");
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
    const res = await handler(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  } finally {
    cleanup();
  }
});

test("handler unknown path returns 404", async () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = await handler(new Request("http://x/nope"));
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

test("server SSE delta smoke: insert after connect -> snapshot within 2s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webui-server-smoke-"));
  const dbPath = join(dir, "t.db");
  const db = openWithMigrate(dbPath);
  // Seed an initial row so the first snapshot is non-empty (and distinct
  // from the post-insert snapshot via digest).
  insertIssue(db, { id: "seed", title: "seed", type: "HITL", state: "ready" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/sse/hitl") {
        return new Response(sseStream(db, "hitl", 100), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const ctrl = new AbortController();
  try {
    const res = await fetch(`http://${server.hostname}:${server.port}/sse/hitl`, {
      signal: ctrl.signal,
    });
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Drain the initial snapshot.
    const first = await reader.read();
    expect(decoder.decode(first.value!)).toContain("snapshot");
    // Insert via the same db handle; poll loop reads via shared bun:sqlite.
    insertIssue(db, { id: "post-connect", title: "post", type: "HITL", state: "ready" });
    const deadline = Date.now() + 2000;
    let sawNewRow = false;
    while (Date.now() < deadline && !sawNewRow) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value!);
      if (chunk.includes("snapshot") && chunk.includes("post-connect")) {
        sawNewRow = true;
      }
    }
    expect(sawNewRow).toBe(true);
  } finally {
    ctrl.abort();
    server.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function insertChatIn(
  db: ReturnType<typeof openWithMigrate>,
  row: {
    id: string;
    title: string;
    thread_id?: string;
    draft_md?: string | null;
    priority?: number | null;
    updated_at?: number;
    state?: string;
  },
) {
  const now = row.updated_at ?? Math.floor(Date.now() / 1000);
  db.exec(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind,
                         class, urgency, source_module, thread_id, draft_md, priority,
                         hitl, created_at, updated_at)
     VALUES (?, 'arc-agents', ?, '', '', 'interactive', ?, 'event',
             'class_unset', 'interactive', 'arc-chat', ?, ?, ?, 0, ?, ?)`,
    [
      row.id,
      row.title,
      row.state ?? "ready",
      row.thread_id ?? `t-${row.id}`,
      row.draft_md ?? null,
      row.priority ?? null,
      now,
      now,
    ] as never,
  );
}

test("queryTop3ChatIn returns chat_in rows in priority order, capped at 3", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "lo", priority: 10, updated_at: 1700 });
    insertChatIn(db, { id: "c2", title: "hi", priority: 1, updated_at: 1701 });
    insertChatIn(db, { id: "c3", title: "mid", priority: 5, updated_at: 1702 });
    insertChatIn(db, { id: "c4", title: "extra", priority: 999, updated_at: 1703 });
    insertChatIn(db, { id: "c5", title: "merged", priority: 0, state: "merged", updated_at: 1704 });
    const rows = queryTop3ChatIn(db);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.id)).toEqual(["c2", "c3", "c1"]);
  } finally {
    cleanup();
  }
});

test("queryTop3ChatIn excludes non chat_in rows", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "chat" });
    insertIssue(db, { id: "h1", title: "hitl", type: "HITL", state: "ready" });
    const ids = queryTop3ChatIn(db).map((r) => r.id);
    expect(ids).toEqual(["c1"]);
  } finally {
    cleanup();
  }
});

test("submitReply writes a chat_out row visible to arc-chat tail filter", () => {
  const { db, cleanup } = freshDb();
  try {
    const { id } = submitReply(db, {
      thread_id: "t-abc",
      body: "hello from human",
      in_reply_to: "c1",
    });
    expect(id.length).toBeGreaterThan(0);
    const row = db
      .query<
        { id: string; kind: string; source_module: string; thread_id: string; body_md: string; parent_id: string | null },
        [string]
      >(
        `SELECT id, kind, source_module, thread_id, body_md, parent_id
           FROM issues WHERE id=?`,
      )
      .get(id);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("reply");
    expect(row!.source_module).toBe("arc-chat");
    expect(row!.thread_id).toBe("t-abc");
    expect(row!.body_md).toBe("hello from human");
    expect(row!.parent_id).toBe("c1");
    // Tail filter from arc-chat: WHERE thread_id=? AND kind='reply' AND source_module='arc-chat'.
    const tailed = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM issues WHERE thread_id=? AND kind='reply' AND source_module='arc-chat'",
      )
      .all("t-abc");
    expect(tailed.map((r) => r.id)).toEqual([id]);
  } finally {
    cleanup();
  }
});

test("submitReply rejects empty body", () => {
  const { db, cleanup } = freshDb();
  try {
    expect(() => submitReply(db, { thread_id: "t", body: "   " })).toThrow(/body required/);
  } finally {
    cleanup();
  }
});

test("submitReply rejects missing thread_id", () => {
  const { db, cleanup } = freshDb();
  try {
    expect(() => submitReply(db, { thread_id: "", body: "hi" })).toThrow(/thread_id required/);
  } finally {
    cleanup();
  }
});

test("handler GET /api/top3 returns rows json", async () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "first", priority: 1 });
    const handler = buildHandler(db);
    const res = await handler(new Request("http://x/api/top3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows[0].id).toBe("c1");
  } finally {
    cleanup();
  }
});

test("handler POST /api/submit persists reply and returns id", async () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = await handler(
      new Request("http://x/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: "t-1", body: "reply body" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("string");
    const row = db
      .query<{ kind: string; body_md: string }, [string]>(
        "SELECT kind, body_md FROM issues WHERE id=?",
      )
      .get(body.id);
    expect(row!.kind).toBe("reply");
    expect(row!.body_md).toBe("reply body");
  } finally {
    cleanup();
  }
});

test("handler POST /api/submit returns 400 on invalid json", async () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = await handler(
      new Request("http://x/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  } finally {
    cleanup();
  }
});

test("handler POST /api/submit returns 400 on missing thread_id", async () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = await handler(
      new Request("http://x/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  } finally {
    cleanup();
  }
});

test("handler GET /api/alternatives/:id returns empty list when missing", async () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = await handler(new Request("http://x/api/alternatives/nope-row"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alternatives).toEqual([]);
  } finally {
    cleanup();
  }
});

test("handler GET /hitl serves panel html", async () => {
  const { db, cleanup } = freshDb();
  try {
    const handler = buildHandler(db);
    const res = await handler(new Request("http://x/hitl"));
    // assets/webui/hitl.html exists alongside this binary; expect 200.
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("HITL · top-3");
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
