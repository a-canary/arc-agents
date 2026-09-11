import { expect, test } from "bun:test";
import { resolveEventAgent } from "./event-agent";

test("explicit agent is recorded verbatim", () => {
  expect(resolveEventAgent("bookie")).toBe("bookie");
  expect(resolveEventAgent("developer")).toBe("developer");
});

test("missing agent is 'cli', never a manufactured 'bookie'", () => {
  expect(resolveEventAgent(undefined)).toBe("cli");
  expect(resolveEventAgent(null)).toBe("cli");
});

test("empty and whitespace-only agent do not smuggle in a blank attribution", () => {
  expect(resolveEventAgent("")).toBe("cli");
  expect(resolveEventAgent("   ")).toBe("cli");
});
