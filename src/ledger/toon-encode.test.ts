import { test, expect } from "bun:test";
import { encode } from "./toon-encode";

test("basic multi-row case emits canonical TOON tabular form", () => {
  const rows = [
    { id: "a", state: "ready" },
    { id: "b", state: "wip" },
  ];
  expect(encode(rows)).toBe(["[2]{id,state}:", "  a,ready", "  b,wip"].join("\n"));
});

test("field selection and ordering via opts.fields", () => {
  const rows = [{ id: "a", state: "ready", title: "x" }];
  // Select a subset, reorder: state before id, drop title.
  expect(encode(rows, { fields: ["state", "id"] })).toBe(
    ["[1]{state,id}:", "  ready,a"].join("\n"),
  );
});

test("limit truncates and appends 'showing N of M' hint", () => {
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
  expect(encode(rows, { limit: 2 })).toBe(
    ["[2]{n}:", "  1", "  2", "  … showing 2 of 4"].join("\n"),
  );
});

test("limit >= total emits no hint", () => {
  const rows = [{ n: 1 }, { n: 2 }];
  expect(encode(rows, { limit: 5 })).toBe(["[2]{n}:", "  1", "  2"].join("\n"));
});

test("empty input returns definitive empty marker", () => {
  expect(encode([])).toBe("[0]{}:");
});

test("values with commas are double-quoted", () => {
  const rows = [{ title: "a,b" }];
  expect(encode(rows)).toBe(['[1]{title}:', '  "a,b"'].join("\n"));
});

test("values with double quotes escape inner quotes", () => {
  const rows = [{ title: 'say "hi"' }];
  expect(encode(rows)).toBe(['[1]{title}:', '  "say ""hi"""'].join("\n"));
});

test("values with newlines are quoted", () => {
  const rows = [{ title: "line1\nline2" }];
  expect(encode(rows)).toBe(['[1]{title}:', '  "line1\nline2"'].join("\n"));
});

test("values with leading/trailing space are quoted", () => {
  const rows = [{ title: " padded " }];
  expect(encode(rows)).toBe(['[1]{title}:', '  " padded "'].join("\n"));
});

test("null and undefined render as empty string", () => {
  const rows = [{ a: null, b: undefined, c: 0 }];
  expect(encode(rows)).toBe(["[1]{a,b,c}:", "  ,,0"].join("\n"));
});
