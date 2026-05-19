import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../ledger/migrate";
import { storeArtifact, readArtifact, absolutePath, INLINE_CUTOFF_BYTES } from "./artifacts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arc-ux-artifacts-"));
  process.env.ARC_ARTIFACTS_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ARC_ARTIFACTS_DIR;
});

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  // Seed an originating issue row to satisfy FK.
  db.run(
    "INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind) VALUES ('row-1', 'test', 't', '', '', 'mvp', 'ready', 'task')",
  );
  return db;
}

test("1 KiB payload -> inline_body set, ref_path NULL, no file written", () => {
  const db = fresh();
  const body = "a".repeat(1024);
  const id = storeArtifact(db, { kind: "text/markdown", body, originating_row_id: "row-1" });
  const a = readArtifact(db, id)!;
  expect(a.inline_body).toBe(body);
  expect(a.ref_path).toBeNull();
  expect(a.bytes).toBe(1024);
});

test("64 KiB payload -> ref_path set, file exists on disk with correct bytes", () => {
  const db = fresh();
  const body = "b".repeat(64 * 1024);
  const id = storeArtifact(db, {
    kind: "text/markdown",
    body,
    originating_row_id: "row-1",
    ext: "md",
  });
  const a = readArtifact(db, id)!;
  expect(a.inline_body).toBeNull();
  expect(a.ref_path).toBe(`${id}.md`);
  expect(a.bytes).toBe(64 * 1024);
  const abs = absolutePath(a.ref_path!);
  expect(existsSync(abs)).toBe(true);
  expect(statSync(abs).size).toBe(64 * 1024);
  expect(readFileSync(abs, "utf8")).toBe(body);
});

test("exact cutoff (16 KiB) stays inline; cutoff+1 goes to disk", () => {
  const db = fresh();
  const atCutoff = "x".repeat(INLINE_CUTOFF_BYTES);
  const overCutoff = "y".repeat(INLINE_CUTOFF_BYTES + 1);
  const a = readArtifact(
    db,
    storeArtifact(db, { kind: "text/plain", body: atCutoff, originating_row_id: "row-1" }),
  )!;
  const b = readArtifact(
    db,
    storeArtifact(db, { kind: "text/plain", body: overCutoff, originating_row_id: "row-1" }),
  )!;
  expect(a.inline_body).not.toBeNull();
  expect(a.ref_path).toBeNull();
  expect(b.inline_body).toBeNull();
  expect(b.ref_path).not.toBeNull();
});

test("Uint8Array payload routes to disk when large", () => {
  const db = fresh();
  const buf = new Uint8Array(32 * 1024).fill(7);
  const id = storeArtifact(db, {
    kind: "image/png",
    body: buf,
    originating_row_id: "row-1",
    ext: "png",
  });
  const a = readArtifact(db, id)!;
  expect(a.ref_path).toBe(`${id}.png`);
  expect(a.bytes).toBe(32 * 1024);
  expect(statSync(absolutePath(a.ref_path!)).size).toBe(32 * 1024);
});

test("missing kind or originating_row_id throws", () => {
  const db = fresh();
  expect(() =>
    storeArtifact(db, { kind: "", body: "x", originating_row_id: "row-1" }),
  ).toThrow();
  expect(() =>
    storeArtifact(db, { kind: "text/plain", body: "x", originating_row_id: "" }),
  ).toThrow();
});
