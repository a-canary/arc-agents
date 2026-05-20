import { expect, test } from "bun:test";
import {
  CLAIMABLE_KINDS,
  CLAIMABLE_KINDS_SQL,
  PARKED_KINDS,
  PARKED_KINDS_SQL,
} from "./kinds";

test("CLAIMABLE_KINDS is the factory-claimable set (task, event)", () => {
  expect(CLAIMABLE_KINDS).toEqual(["task", "event"]);
});

test("PARKED_KINDS is the by-design non-claimable set (prd)", () => {
  expect(PARKED_KINDS).toEqual(["prd"]);
});

test("CLAIMABLE_KINDS and PARKED_KINDS are disjoint", () => {
  const overlap = CLAIMABLE_KINDS.filter((k) =>
    (PARKED_KINDS as readonly string[]).includes(k),
  );
  expect(overlap).toEqual([]);
});

test("SQL fragments quote and comma-join correctly", () => {
  expect(CLAIMABLE_KINDS_SQL).toBe("'task','event'");
  expect(PARKED_KINDS_SQL).toBe("'prd'");
});
