// `ledger update` guards: --help must not be parsed as a task id, and a
// nonexistent id must exit nonzero instead of reporting {updated: true}.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate, mintId } from "./db";

const BIN = join(import.meta.dir, "../../bin/ledger.ts");

function run(...argv: string[]) {
  const p = Bun.spawnSync(["bun", BIN, ...argv]);
  return {
    code: p.exitCode,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
}

function freshDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "update-guard-"));
  const path = join(dir, "t.db");
  openWithMigrate(path).close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("update --help prints help, does not report updated:true", () => {
  const r = run("update", "--help");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("ledger <verb> [args]");
  expect(r.stdout).not.toContain('"updated"');
});

test("update with flag-shaped id exits nonzero", () => {
  const { path, cleanup } = freshDb();
  try {
    // positionalAfterVerb strips --state/failed as a flag+value pair, so
    // this leaves no positional at all -> "id required", not a flag-shaped
    // id. See the next test for the flag-shaped-id message specifically.
    const r = run("update", "--state", "failed", "--db", path);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("id required");
  } finally {
    cleanup();
  }
});

test("update with nonexistent id exits nonzero, no ghost success", () => {
  const { path, cleanup } = freshDb();
  try {
    const r = run("update", "no-such-row", "--evidence", "x", "--db", path);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no such issue");
    expect(r.stdout).not.toContain('"updated": true');
  } finally {
    cleanup();
  }
});

test("update with --db preceding verb still finds id (not misread as db path)", () => {
  const { path, cleanup } = freshDb();
  try {
    const db = openWithMigrate(path);
    const id = mintId(db, "guard fixture row --db-first");
    db.run(
      `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
       VALUES (?, 'arc-agents', 'guard fixture row', '', '', 'quality', 'ready', 'task', 'hygiene', 'explore')`,
      [id],
    );
    db.close();
    const r = run("--db", path, "update", id, "--evidence", "x");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"updated": true');
  } finally {
    cleanup();
  }
});

test("update with --in-place preceding id does not eat id as its value", () => {
  const { path, cleanup } = freshDb();
  try {
    const db = openWithMigrate(path);
    const id = mintId(db, "guard fixture row --in-place-first");
    db.run(
      `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
       VALUES (?, 'arc-agents', 'guard fixture row', '', '', 'quality', 'ready', 'task', 'hygiene', 'explore')`,
      [id],
    );
    db.close();
    const r = run("update", "--in-place", id, "--evidence", "x", "--db", path);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"updated": true');
  } finally {
    cleanup();
  }
});

test("update with real id still succeeds", () => {
  const { path, cleanup } = freshDb();
  try {
    const db = openWithMigrate(path);
    const id = mintId(db, "guard fixture row");
    db.run(
      `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
       VALUES (?, 'arc-agents', 'guard fixture row', '', '', 'quality', 'ready', 'task', 'hygiene', 'explore')`,
      [id],
    );
    db.close();
    const r = run("update", id, "--evidence", "x", "--db", path);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"updated": true');
  } finally {
    cleanup();
  }
});
