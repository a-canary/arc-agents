import { test, expect } from "bun:test";
import { validateCreate, validateStateTransition, KIND_VALUES, TYPE_VALUES } from "./bookie-validator";

test("rejects positional args entirely", () => {
  const errs = validateCreate({ title: "ok", kind: "task", type: "mvp" }, ["task", "developer", "ok"]);
  expect(errs.some((e) => e.field === "args")).toBe(true);
});

test("accepts flag-only create with valid enums", () => {
  expect(validateCreate({ title: "ok", kind: "task", type: "mvp" })).toEqual([]);
});

test("rejects title that looks like a flag", () => {
  const errs = validateCreate({ title: "--role", kind: "task", type: "mvp" });
  expect(errs.some((e) => e.field === "--title")).toBe(true);
});

test("rejects unknown kind", () => {
  const errs = validateCreate({ title: "ok", kind: "weird", type: "mvp" });
  expect(errs.some((e) => e.field === "--kind")).toBe(true);
});

test("rejects unknown type", () => {
  const errs = validateCreate({ title: "ok", kind: "task", type: "urgent" });
  expect(errs.some((e) => e.field === "--type")).toBe(true);
});

test("accepts all kind enum values", () => {
  for (const k of KIND_VALUES) {
    expect(validateCreate({ title: "ok", kind: k, type: "mvp" })).toEqual([]);
  }
});

test("accepts all type enum values", () => {
  for (const t of TYPE_VALUES) {
    expect(validateCreate({ title: "ok", kind: "task", type: t })).toEqual([]);
  }
});

test("rejects bad blocked-by shape", () => {
  expect(validateCreate({ title: "ok", kind: "task", type: "mvp", blockedBy: "i-foo" }).some((e) => e.field === "--blocked-by")).toBe(true);
  expect(validateCreate({ title: "ok", kind: "task", type: "mvp", blockedBy: "[1,2]" }).some((e) => e.field === "--blocked-by")).toBe(true);
});

test("accepts well-formed blocked-by", () => {
  expect(validateCreate({ title: "ok", kind: "task", type: "mvp", blockedBy: '["i-a","i-b"]' })).toEqual([]);
});

test("validateStateTransition blocks exit from terminal states", () => {
  expect(validateStateTransition("merged", "ready").length).toBeGreaterThan(0);
  expect(validateStateTransition("cancelled", "ready").length).toBeGreaterThan(0);
  expect(validateStateTransition("ready", "claimed")).toEqual([]);
  expect(validateStateTransition("claimed", "wip")).toEqual([]);
});
