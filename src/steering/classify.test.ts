import { test, expect, describe } from "bun:test";
import { parse, type Steering } from "./classify";

describe("steering parse() — heuristic (no forceMode)", () => {
  const cases: Array<{ name: string; input: string; expect: Steering }> = [
    // Rule 1: leading ! ⇒ imperative, marker stripped + boundary trim
    {
      name: "leading bang ⇒ imperative",
      input: "!ship it now",
      expect: { mode: "imperative", payload: "ship it now" },
    },
    {
      name: "leading whitespace before bang trimmed, one space after stripped",
      input: "  ! do the thing",
      expect: { mode: "imperative", payload: "do the thing" },
    },
    {
      name: "no space after bang",
      input: "!do it",
      expect: { mode: "imperative", payload: "do it" },
    },
    // Rule 2: plain text ⇒ hypothesis, verbatim
    {
      name: "plain text ⇒ hypothesis verbatim",
      input: "maybe we should cache this",
      expect: { mode: "hypothesis", payload: "maybe we should cache this" },
    },
    // Rule 4: payload preserved verbatim — internal whitespace, trailing kept
    {
      name: "internal + trailing whitespace preserved in imperative",
      input: "!run   the  test   ",
      expect: { mode: "imperative", payload: "run   the  test   " },
    },
    {
      name: "only ONE space after bang stripped",
      input: "!  two leading spaces become one",
      expect: { mode: "imperative", payload: " two leading spaces become one" },
    },
    {
      name: "hypothesis preserves leading/trailing whitespace verbatim",
      input: "  spacey thought  ",
      expect: { mode: "hypothesis", payload: "  spacey thought  " },
    },
    // Rule 5: edge cases
    {
      name: "empty string ⇒ hypothesis empty payload",
      input: "",
      expect: { mode: "hypothesis", payload: "" },
    },
    {
      name: "bare bang ⇒ imperative empty payload",
      input: "!",
      expect: { mode: "imperative", payload: "" },
    },
    {
      name: "double bang ⇒ only one marker stripped",
      input: "!!double",
      expect: { mode: "imperative", payload: "!double" },
    },
    {
      name: "whitespace-only ⇒ hypothesis verbatim",
      input: "   ",
      expect: { mode: "hypothesis", payload: "   " },
    },
    {
      name: "bang then only whitespace",
      input: "!   ",
      expect: { mode: "imperative", payload: "  " },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(parse(c.input)).toEqual(c.expect);
    });
  }
});

describe("steering parse() — forceMode override (Rule 3)", () => {
  test("forceMode hypothesis overrides leading bang, strips marker", () => {
    expect(parse("!do it", { forceMode: "hypothesis" })).toEqual({
      mode: "hypothesis",
      payload: "do it",
    });
  });

  test("forceMode imperative on plain text ⇒ imperative, verbatim payload", () => {
    expect(parse("just a thought", { forceMode: "imperative" })).toEqual({
      mode: "imperative",
      payload: "just a thought",
    });
  });

  test("forceMode imperative on bang input still strips marker", () => {
    expect(parse("!already a command", { forceMode: "imperative" })).toEqual({
      mode: "imperative",
      payload: "already a command",
    });
  });

  test("forceMode hypothesis on plain text ⇒ hypothesis verbatim", () => {
    expect(parse("maybe cache", { forceMode: "hypothesis" })).toEqual({
      mode: "hypothesis",
      payload: "maybe cache",
    });
  });

  test("forceMode hypothesis on bare bang ⇒ empty payload", () => {
    expect(parse("!", { forceMode: "hypothesis" })).toEqual({
      mode: "hypothesis",
      payload: "",
    });
  });
});
