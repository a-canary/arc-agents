import { test, expect } from "bun:test";
import { validateCreate, validateStateTransition, KIND_VALUES, CLASS_VALUES, URGENCY_VALUES } from "./bookie-validator";

const base = { kind: "task", class: "MVP", urgency: "nominal" } as const;

test("rejects positional args entirely", () => {
  const errs = validateCreate({ title: "ok", ...base }, ["task", "developer", "ok"]);
  expect(errs.some((e) => e.field === "args")).toBe(true);
});

test("accepts flag-only create with valid enums", () => {
  expect(validateCreate({ title: "ok", ...base })).toEqual([]);
});

test("rejects title that looks like a flag", () => {
  const errs = validateCreate({ title: "--role", ...base });
  expect(errs.some((e) => e.field === "--title")).toBe(true);
});

test("rejects unknown kind", () => {
  const errs = validateCreate({ title: "ok", kind: "weird", class: "MVP", urgency: "nominal" });
  expect(errs.some((e) => e.field === "--kind")).toBe(true);
});

test("rejects unknown class", () => {
  const errs = validateCreate({ title: "ok", kind: "task", class: "urgent", urgency: "nominal" });
  expect(errs.some((e) => e.field === "--class")).toBe(true);
});

test("rejects unknown urgency", () => {
  const errs = validateCreate({ title: "ok", kind: "task", class: "MVP", urgency: "whenever" });
  expect(errs.some((e) => e.field === "--urgency")).toBe(true);
});

test("rejects legacy --type with ADR 0005 hint", () => {
  const errs = validateCreate({ title: "ok", ...base, legacyType: "mvp" });
  const e = errs.find((e) => e.field === "--type");
  expect(e).toBeDefined();
  expect(e!.message).toContain("ADR 0005");
});

test("accepts all kind enum values", () => {
  for (const k of KIND_VALUES) {
    expect(validateCreate({ title: "ok", kind: k, class: "MVP", urgency: "nominal" })).toEqual([]);
  }
});

test("accepts all class enum values", () => {
  for (const c of CLASS_VALUES) {
    expect(validateCreate({ title: "ok", kind: "task", class: c, urgency: "nominal" })).toEqual([]);
  }
});

test("accepts all urgency enum values", () => {
  for (const u of URGENCY_VALUES) {
    expect(validateCreate({ title: "ok", kind: "task", class: "MVP", urgency: u })).toEqual([]);
  }
});

test("rejects bad --hitl values", () => {
  expect(validateCreate({ title: "ok", ...base, hitl: "yes" }).some((e) => e.field === "--hitl")).toBe(true);
  expect(validateCreate({ title: "ok", ...base, hitl: "1" })).toEqual([]);
  expect(validateCreate({ title: "ok", ...base, hitl: "0" })).toEqual([]);
});

test("rejects bad blocked-by shape", () => {
  expect(validateCreate({ title: "ok", ...base, blockedBy: "i-foo" }).some((e) => e.field === "--blocked-by")).toBe(true);
  expect(validateCreate({ title: "ok", ...base, blockedBy: "[1,2]" }).some((e) => e.field === "--blocked-by")).toBe(true);
});

test("accepts well-formed blocked-by", () => {
  expect(validateCreate({ title: "ok", ...base, blockedBy: '["i-a","i-b"]' })).toEqual([]);
});

test("validateStateTransition blocks exit from terminal states", () => {
  expect(validateStateTransition("merged", "ready").length).toBeGreaterThan(0);
  expect(validateStateTransition("cancelled", "ready").length).toBeGreaterThan(0);
  expect(validateStateTransition("ready", "claimed")).toEqual([]);
  expect(validateStateTransition("claimed", "wip")).toEqual([]);
});
