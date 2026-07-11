import { describe, expect, test } from "bun:test";
import { parseVerdict, stamp } from "./gate-triage.ts";

describe("parseVerdict", () => {
  test("accepts valid auto verdict with tool list", () => {
    const v = parseVerdict('noise before {"gate":"auto","reason":"ops work","allowed_tools":["Read","Bash"]} after');
    expect(v).toEqual({ gate: "auto", reason: "ops work", allowed_tools: ["Read", "Bash"] });
  });
  test("accepts human verdict", () => {
    expect(parseVerdict('{"gate":"human","reason":"objective delta","allowed_tools":[]}')?.gate).toBe("human");
  });
  test("rejects bad gate, missing reason, non-array tools, garbage", () => {
    expect(parseVerdict('{"gate":"maybe","reason":"x","allowed_tools":[]}')).toBeNull();
    expect(parseVerdict('{"gate":"auto","allowed_tools":[]}')).toBeNull();
    expect(parseVerdict('{"gate":"auto","reason":"x","allowed_tools":"Bash"}')).toBeNull();
    expect(parseVerdict("no json here")).toBeNull();
  });
  test("drops non-string tools", () => {
    expect(parseVerdict('{"gate":"auto","reason":"x","allowed_tools":["Read",5,null]}')?.allowed_tools).toEqual(["Read"]);
  });
});

describe("stamp", () => {
  test("human stamp carries HUMAN GATE and the marker", () => {
    const s = stamp({ gate: "human", reason: "changes APR target", allowed_tools: [] });
    expect(s).toContain("<!-- gate-triage -->");
    expect(s).toContain("HUMAN GATE");
    expect(s).toContain("changes APR target");
  });
  test("auto stamp carries allowed-tools + escalation rule", () => {
    const s = stamp({ gate: "auto", reason: "hygiene", allowed_tools: ["Read", "Edit", "Bash"] });
    expect(s).toContain("allowed-tools: Read, Edit, Bash");
    expect(s).toContain("model: opus");
    expect(s).toContain("auto-approved");
  });
});
