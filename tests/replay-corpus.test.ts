// Smoke tests for the seed replay-shadow corpus (S-0003).
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "replay-corpus");

const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

test("corpus has at least 30 fixtures", () => {
  expect(dirs.length).toBeGreaterThanOrEqual(30);
});

test("MANIFEST.json lists every fixture", () => {
  const mf = JSON.parse(readFileSync(join(ROOT, "MANIFEST.json"), "utf8"));
  expect(mf.count).toBe(mf.fixtures.length);
  const listed = new Set(mf.fixtures.map((f: any) => f.fixture_id));
  for (const d of dirs) expect(listed.has(d)).toBe(true);
});

test("each fixture has required artifacts", () => {
  for (const d of dirs) {
    const fp = join(ROOT, d);
    expect(existsSync(join(fp, "fixture.json"))).toBe(true);
    expect(existsSync(join(fp, "session.jsonl"))).toBe(true);
    expect(existsSync(join(fp, "ledger-seed.json"))).toBe(true);
    expect(existsSync(join(fp, "ledger-diff.json"))).toBe(true);
    expect(statSync(join(fp, "session.jsonl")).size).toBeGreaterThan(0);
  }
});

test("fixture.json matches FIXTURE-SCHEMA.md $schema_version=1 shape", () => {
  for (const d of dirs) {
    const f = JSON.parse(readFileSync(join(ROOT, d, "fixture.json"), "utf8"));
    expect(f.$schema_version).toBe(1);
    expect(f.fixture_id).toBe(d);
    expect(typeof f.captured_at).toBe("number");
    expect(f.source.system).toBe("arc-agents");
    expect(f.unit.task_id).toBe(d);
    expect(["merged", "failed", "blocked", "cancelled"]).toContain(
      f.unit.terminal_state,
    );
    expect(f.transcript.session_jsonl).toBe("session.jsonl");
    expect(Array.isArray(f.transcript.tool_calls)).toBe(true);
    expect(Array.isArray(f.output_diff.ledger_writes)).toBe(true);
    expect(Array.isArray(f.output_diff.ledger_state_transitions)).toBe(true);
  }
});

test("terminal-state mix is diverse (not all merged)", () => {
  const states = dirs.map((d) => {
    const f = JSON.parse(readFileSync(join(ROOT, d, "fixture.json"), "utf8"));
    return f.unit.terminal_state;
  });
  const uniq = new Set(states);
  expect(uniq.size).toBeGreaterThanOrEqual(2);
});
