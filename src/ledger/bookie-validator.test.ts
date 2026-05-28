// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "bun:test";
import {
  validateCreate,
  validateStateTransition,
  validateBookieWrite,
  KIND_VALUES,
  TYPE_VALUES,
  type BookieWriteInput,
  type ModuleRegistry,
} from "./bookie-validator";

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

// ADR 0005 — table-driven coverage of validateBookieWrite.
const REGISTRY: ModuleRegistry = new Set(["arc-chat", "arc-webui"]);

type Case = {
  name: string;
  row: BookieWriteInput;
  expectField: string | null; // null = valid
};

const CASES: Case[] = [
  {
    name: "valid task row",
    row: { kind: "task", class: "MVP", urgency: "nominal", class_rationale: "CHOICES M-0001" },
    expectField: null,
  },
  {
    name: "valid event row with source_module",
    row: {
      kind: "event",
      class: "ops",
      urgency: "nominal",
      source_module: "arc-chat",
      class_rationale: "ops note",
    },
    expectField: null,
  },
  {
    name: "valid class_unset + triage_pending",
    row: { kind: "task", class: "class_unset", urgency: "nominal", triage_pending: true },
    expectField: null,
  },
  { name: "bad kind", row: { kind: "weird", class: "MVP", urgency: "nominal", class_rationale: "x" }, expectField: "kind" },
  // Migration 017: validator emits field="tier"/"pool" even when old aliases are used
  { name: "bad class", row: { kind: "task", class: "huge", urgency: "nominal", class_rationale: "x" }, expectField: "tier" },
  { name: "bad urgency", row: { kind: "task", class: "MVP", urgency: "asap", class_rationale: "x" }, expectField: "pool" },
  {
    name: "class_unset without triage_pending",
    row: { kind: "task", class: "class_unset", urgency: "nominal", class_rationale: "x" },
    expectField: "tier",
  },
  {
    name: "missing source_module on event",
    row: { kind: "event", class: "ops", urgency: "nominal", class_rationale: "x" },
    expectField: "source_module",
  },
  {
    name: "missing source_module on reply",
    row: { kind: "reply", class: "ops", urgency: "nominal", class_rationale: "x" },
    expectField: "source_module",
  },
  {
    name: "unknown source_module",
    row: {
      kind: "event",
      class: "ops",
      urgency: "nominal",
      source_module: "ghost",
      class_rationale: "x",
    },
    expectField: "source_module",
  },
  {
    name: "missing class_rationale",
    row: { kind: "task", class: "MVP", urgency: "nominal" },
    expectField: "class_rationale",
  },
];

for (const c of CASES) {
  test(`validateBookieWrite: ${c.name}`, () => {
    const errs = validateBookieWrite(c.row, REGISTRY);
    if (c.expectField === null) {
      expect(errs).toEqual([]);
    } else {
      expect(errs.some((e) => e.field === c.expectField)).toBe(true);
    }
  });
}

test("validateStateTransition blocks exit from terminal states", () => {
  expect(validateStateTransition("merged", "ready").length).toBeGreaterThan(0);
  expect(validateStateTransition("cancelled", "ready").length).toBeGreaterThan(0);
  expect(validateStateTransition("ready", "claimed")).toEqual([]);
  expect(validateStateTransition("claimed", "wip")).toEqual([]);
});

// ── Change 2: KIND_VALUES += "sprint" ────────────────────────────────────────

test("KIND_VALUES includes 'sprint'", () => {
  expect(KIND_VALUES as readonly string[]).toContain("sprint");
});

test("validateCreate: kind='sprint' returns no --kind error", () => {
  const errs = validateCreate({ title: "ok", kind: "sprint", type: "mvp" });
  expect(errs.some((e) => e.field === "--kind")).toBe(false);
});
