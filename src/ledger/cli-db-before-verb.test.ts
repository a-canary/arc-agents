// Regression: `ledger --db <path> show <id>` must not misread the db path
// as the issue id (pre-verb --db used to survive into positionals).
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "../../bin/ledger.ts");

function run(args: string[]) {
  const p = Bun.spawnSync(["bun", BIN, ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const db = join(mkdtempSync(join(tmpdir(), "ledger-db-flag-")), "t.db");

test("--db before verb: id resolved from positional, not db path", () => {
  expect(run(["init", "--db", db]).code).toBe(0);
  const r = run(["--db", db, "show", "nonexistent-id"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no such issue: nonexistent-id");
  expect(r.err).not.toContain(db);
});

test("--db=<path> before verb works too", () => {
  const r = run([`--db=${db}`, "show", "nonexistent-id"]);
  expect(r.err).toContain("no such issue: nonexistent-id");
});

test("--db after verb unchanged", () => {
  const r = run(["show", "nonexistent-id", "--db", db]);
  expect(r.err).toContain("no such issue: nonexistent-id");
});
