import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import {
  buildHandler,
  getArtifactDir,
  listArtifactFiles,
  queryAfkRows,
  queryHitlRows,
  resolveArtifactFile,
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

function freshArtifactDir() {
  const dir = mkdtempSync(join(tmpdir(), "webui-art-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("listArtifactFiles returns relative paths sorted, recursive", () => {
  const { dir, cleanup } = freshArtifactDir();
  try {
    writeFileSync(join(dir, "a.txt"), "hello");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.md"), "world");
    const files = listArtifactFiles(dir);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(["a.txt", "sub/b.md"]);
    expect(files[0]!.size).toBe(5);
  } finally {
    cleanup();
  }
});

test("listArtifactFiles respects cap", () => {
  const { dir, cleanup } = freshArtifactDir();
  try {
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
    const files = listArtifactFiles(dir, 3);
    expect(files.length).toBe(3);
  } finally {
    cleanup();
  }
});

test("resolveArtifactFile rejects traversal", () => {
  const { dir, cleanup } = freshArtifactDir();
  try {
    expect(resolveArtifactFile(dir, "../etc/passwd")).toBeNull();
    expect(resolveArtifactFile(dir, "/etc/passwd")).toBeNull();
    expect(resolveArtifactFile(dir, "")).toBeNull();
    writeFileSync(join(dir, "ok.txt"), "x");
    expect(resolveArtifactFile(dir, "ok.txt")).toBe(join(dir, "ok.txt"));
  } finally {
    cleanup();
  }
});

test("getArtifactDir returns null for missing row, dir otherwise", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "row1", title: "t", state: "ready" });
    db.exec("UPDATE issues SET artifact_dir = '/tmp/x' WHERE id = 'row1'");
    expect(getArtifactDir(db, "row1")).toEqual({ kind: "ok", dir: "/tmp/x" });
    expect(getArtifactDir(db, "missing")).toEqual({ kind: "missing" });
    insertIssue(db, { id: "row2", title: "t", state: "ready" });
    expect(getArtifactDir(db, "row2")).toEqual({ kind: "unset" });
  } finally {
    cleanup();
  }
});

test("handler /artifacts/:row_id returns 404 for missing row", async () => {
  const { db, cleanup } = freshDb();
  try {
    const res = buildHandler(db)(new Request("http://x/artifacts/nope"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/row not found/);
  } finally {
    cleanup();
  }
});

test("handler /artifacts/:row_id returns 404 when artifact_dir unset", async () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, { id: "r", title: "t", state: "ready" });
    const res = buildHandler(db)(new Request("http://x/artifacts/r"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no artifact_dir/);
  } finally {
    cleanup();
  }
});

test("handler /artifacts/:row_id lists files", async () => {
  const { db, cleanup } = freshDb();
  const art = freshArtifactDir();
  try {
    insertIssue(db, { id: "r", title: "t", state: "ready" });
    db.exec(`UPDATE issues SET artifact_dir = ? WHERE id = 'r'`, [art.dir] as never);
    writeFileSync(join(art.dir, "a.txt"), "hi");
    writeFileSync(join(art.dir, "b.txt"), "yo");
    const res = buildHandler(db)(new Request("http://x/artifacts/r"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.row_id).toBe("r");
    expect(body.artifact_dir).toBe(art.dir);
    expect(body.files.map((f: any) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(body.truncated).toBe(false);
  } finally {
    art.cleanup();
    cleanup();
  }
});

test("handler /artifacts/:row_id/file returns contents", async () => {
  const { db, cleanup } = freshDb();
  const art = freshArtifactDir();
  try {
    insertIssue(db, { id: "r", title: "t", state: "ready" });
    db.exec(`UPDATE issues SET artifact_dir = ? WHERE id = 'r'`, [art.dir] as never);
    writeFileSync(join(art.dir, "a.txt"), "payload");
    const res = buildHandler(db)(
      new Request("http://x/artifacts/r/file?path=a.txt"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload");
  } finally {
    art.cleanup();
    cleanup();
  }
});

test("handler /artifacts/:row_id/file rejects traversal", async () => {
  const { db, cleanup } = freshDb();
  const art = freshArtifactDir();
  try {
    insertIssue(db, { id: "r", title: "t", state: "ready" });
    db.exec(`UPDATE issues SET artifact_dir = ? WHERE id = 'r'`, [art.dir] as never);
    const res = buildHandler(db)(
      new Request("http://x/artifacts/r/file?path=../../etc/passwd"),
    );
    expect(res.status).toBe(400);
  } finally {
    art.cleanup();
    cleanup();
  }
});

test("handler /artifacts/:row_id/file 404 for missing file", async () => {
  const { db, cleanup } = freshDb();
  const art = freshArtifactDir();
  try {
    insertIssue(db, { id: "r", title: "t", state: "ready" });
    db.exec(`UPDATE issues SET artifact_dir = ? WHERE id = 'r'`, [art.dir] as never);
    const res = buildHandler(db)(
      new Request("http://x/artifacts/r/file?path=nope.txt"),
    );
    expect(res.status).toBe(404);
  } finally {
    art.cleanup();
    cleanup();
  }
});
