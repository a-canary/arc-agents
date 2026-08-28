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

// clarify-docs-ledger-update-help-text-und (superseded 2026-08-28 by
// ledger-update-die-on-unknown-flags-silen): the help text must name the full
// metadata-patch flag set (no --state), not just --agent/--project, and
// document that unknown flags are a hard error (the old "silently ignored"
// contract was the incident this task fixes).
test("update --help documents the full metadata-patch flag set", () => {
  const r = run("update", "--help");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("metadata patch");
  expect(r.stdout).toMatch(/--evidence, --pr/);
  expect(r.stdout).toMatch(/Unknown flags are a hard\s+error/);
});

test("update with flag-shaped id exits nonzero", () => {
  const { path, cleanup } = freshDb();
  try {
    const r = run("update", "--state", "failed", "--db", path);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("expected task id");
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

function fixtureRow(path: string): string {
  const db = openWithMigrate(path);
  const id = mintId(db, "update guard row");
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES (?, 'arc-agents', 'update guard row', '', '', 'quality', 'ready', 'task', 'tier_unset', 'pool_unset')`,
    [id],
  );
  db.close();
  return id;
}

function readRow(path: string, id: string) {
  const db = openWithMigrate(path);
  const row = db
    .query<{ state: string; tier: string; pool: string }, [string]>(
      "SELECT state, tier, pool FROM issues WHERE id=?",
    )
    .get(id)!;
  db.close();
  return row;
}

test("update honors --pool/--tier as metadata patches (triage-assign contract)", () => {
  const { path, cleanup } = freshDb();
  try {
    const id = fixtureRow(path);
    const r = run("update", id, "--agent", "developer", "--pool", "build", "--tier", "quality", "--db", path);
    expect(r.code).toBe(0);
    const row = readRow(path, id);
    expect(row.pool).toBe("build");
    expect(row.tier).toBe("quality");
    expect(row.state).toBe("ready"); // metadata patch, no state change
  } finally {
    cleanup();
  }
});

test("update --pool/--tier validate against enums", () => {
  const { path, cleanup } = freshDb();
  try {
    const id = fixtureRow(path);
    const badPool = run("update", id, "--pool", "not-a-pool", "--db", path);
    expect(badPool.code).not.toBe(0);
    expect(badPool.stderr).toContain("must be one of");
    const badTier = run("update", id, "--tier", "not-a-tier", "--db", path);
    expect(badTier.code).not.toBe(0);
    expect(badTier.stderr).toContain("must be one of");
    // Row untouched after both refusals.
    const row = readRow(path, id);
    expect(row.pool).toBe("pool_unset");
    expect(row.tier).toBe("tier_unset");
  } finally {
    cleanup();
  }
});

test("create dies on unknown flags (silent-drop guard)", () => {
  const { path, cleanup } = freshDb();
  try {
    const r = run(
      "create", "--kind", "task", "--type", "mvp", "--title", "x",
      "--bogus-flag", "1", "--db", path,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown flag for create");
  } finally {
    cleanup();
  }
});

test("update dies on unknown flags (silent-drop guard)", () => {
  // Live incident: `--evidence-file` was silently dropped while the CLI
  // reported updated:true — the row merged with no evidence. Unknown flags
  // must now exit nonzero before any write.
  const { path, cleanup } = freshDb();
  try {
    const id = fixtureRow(path);
    const r = run("update", id, "--evidence-file", "/tmp/x.md", "--state", "wip", "--db", path);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown flag");
    // Row untouched: state still ready.
    expect(readRow(path, id).state).toBe("ready");
  } finally {
    cleanup();
  }
});
