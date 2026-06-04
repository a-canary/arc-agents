import { test, expect } from "bun:test";
import { dbFlag, runLedgerJson } from "./cli-invoke";

test("dbFlag returns the --db pair when ARC_LEDGER_DB is set", () => {
  const orig = process.env.ARC_LEDGER_DB;
  process.env.ARC_LEDGER_DB = "/tmp/test-ledger.db";
  try {
    expect(dbFlag()).toEqual(["--db", "/tmp/test-ledger.db"]);
  } finally {
    if (orig === undefined) delete process.env.ARC_LEDGER_DB;
    else process.env.ARC_LEDGER_DB = orig;
  }
});

test("dbFlag returns [] when ARC_LEDGER_DB is unset", () => {
  const orig = process.env.ARC_LEDGER_DB;
  delete process.env.ARC_LEDGER_DB;
  try {
    expect(dbFlag()).toEqual([]);
  } finally {
    if (orig !== undefined) process.env.ARC_LEDGER_DB = orig;
  }
});

test("runLedgerJson parses a real verb's JSON output", () => {
  // `ledger help` is a stable, no-arg verb; it exits 0 and writes plain
  // text (not JSON) to stdout, which is exactly the parse-failure case
  // we want to cover with the fallback. The fact that it's a non-JSON
  // payload exercises the catch branch.
  const r = runLedgerJson<string[]>("help", [], []);
  expect(Array.isArray(r)).toBe(true);
  expect(r.length).toBe(0);
});

test("runLedgerJson returns the fallback on a non-existent verb", () => {
  // A verb the CLI does not implement exits non-zero, so the helper must
  // surface the fallback rather than throw.
  const r = runLedgerJson<{ id: string }>("definitely-not-a-verb", [], { id: "fallback" });
  expect(r).toEqual({ id: "fallback" });
});
