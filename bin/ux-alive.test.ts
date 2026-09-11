import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { heartbeats, report } from "./ux-alive";

function seed(ages: Record<string, number>): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE ux_heartbeats (module_name TEXT PRIMARY KEY, last_beat INTEGER NOT NULL)");
  for (const [name, age] of Object.entries(ages)) {
    db.run("INSERT INTO ux_heartbeats VALUES (?, strftime('%s','now') - ?)", [name, age]);
  }
  return db;
}

test("no heartbeat rows means no alive module", () => {
  const { lines, exitCode } = report(heartbeats(seed({})));
  expect(exitCode).toBe(1);
  expect(lines).toEqual(["(no ux_heartbeats rows)"]);
});

test("every beat stale (>=300s) means no alive module", () => {
  const { lines, exitCode } = report(heartbeats(seed({ "arc-tui": 300, "dev-quest": 9999 })));
  expect(exitCode).toBe(1);
  expect(lines.join("\n")).not.toContain("ALIVE");
});

test("one fresh beat (<300s) is enough to be alive", () => {
  const { lines, exitCode } = report(heartbeats(seed({ "arc-tui": 299, "dev-quest": 9999 })));
  expect(exitCode).toBe(0);
  expect(lines.filter((l) => l.includes("ALIVE"))).toHaveLength(1);
});
