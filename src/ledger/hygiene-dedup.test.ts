// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  checkDuplicate,
  inferSkillFromTitle,
  levenshtein,
  normalizeTitle,
  type ExistingRow,
} from "./hygiene-dedup";

describe("normalizeTitle", () => {
  test("lowercases, strips punctuation, collapses spaces", () => {
    expect(normalizeTitle("Hello,   World!")).toBe("hello world");
  });
  test("strips known skill prefix", () => {
    expect(normalizeTitle("clarify-docs: stale reference to launch.ts")).toBe(
      "stale reference to launch ts",
    );
  });
  test("empty/whitespace input", () => {
    expect(normalizeTitle("   ")).toBe("");
  });
});

describe("levenshtein", () => {
  test("identical strings → 0", () => {
    expect(levenshtein("foo", "foo")).toBe(0);
  });
  test("empty vs nonempty → length", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
  test("single edit", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
    expect(levenshtein("cat", "cats")).toBe(1);
  });
  test("multiple edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("checkDuplicate", () => {
  const ready = (id: string, title: string, extra: Partial<ExistingRow> = {}): ExistingRow => ({
    id,
    title,
    tier: "hygiene",
    state: "ready",
    skill: null,
    ...extra,
  });

  test("no existing rows → not duplicate", () => {
    expect(checkDuplicate("clarify-docs", "foo", [])).toEqual({ duplicate: false });
  });

  test("exact normalized match → duplicate (exact)", () => {
    const rows = [ready("i-1", "clarify-docs: Foo Bar!")];
    const r = checkDuplicate("clarify-docs", "clarify-docs: foo bar", rows);
    expect(r).toEqual({ duplicate: true, existingId: "i-1", reason: "exact" });
  });

  test("substring match → duplicate (substring)", () => {
    const rows = [ready("i-2", "clarify-docs: dead import in src/foo.ts that should be removed")];
    const r = checkDuplicate("clarify-docs", "clarify-docs: dead import in src/foo.ts", rows);
    expect(r.duplicate).toBe(true);
    if (r.duplicate) expect(r.reason).toBe("substring");
  });

  test("levenshtein within threshold → duplicate (levenshtein)", () => {
    const rows = [ready("i-3", "clarify-docs: rename foo helper")];
    const r = checkDuplicate("clarify-docs", "clarify-docs: rename Foo helpr", rows);
    expect(r.duplicate).toBe(true);
    if (r.duplicate) expect(["levenshtein", "exact", "substring"]).toContain(r.reason);
  });

  test("distinct observations beyond threshold → not duplicate", () => {
    const rows = [ready("i-4", "clarify-docs: dead import in src/foo.ts")];
    const r = checkDuplicate("clarify-docs", "clarify-docs: dead import in src/bar.ts", rows, {
      threshold: 0.1,
    });
    expect(r.duplicate).toBe(false);
  });

  test("different skill → not duplicate", () => {
    const rows = [ready("i-5", "improve-architecture: extract foo module")];
    const r = checkDuplicate("clarify-docs", "clarify-docs: extract foo module", rows);
    expect(r.duplicate).toBe(false);
  });

  test("merged state → ignored, re-emission allowed", () => {
    const rows = [
      ready("i-6", "clarify-docs: stale ref", { state: "merged" }),
    ];
    const r = checkDuplicate("clarify-docs", "clarify-docs: stale ref", rows);
    expect(r.duplicate).toBe(false);
  });

  test("cancelled state → ignored", () => {
    const rows = [ready("i-7", "clarify-docs: x", { state: "cancelled" })];
    const r = checkDuplicate("clarify-docs", "clarify-docs: x", rows);
    expect(r.duplicate).toBe(false);
  });

  test("non-hygiene tier → ignored", () => {
    const rows = [ready("i-8", "clarify-docs: x", { tier: "mvp" })];
    const r = checkDuplicate("clarify-docs", "clarify-docs: x", rows);
    expect(r.duplicate).toBe(false);
  });

  test("explicit skill on row beats title-prefix inference", () => {
    const rows = [
      ready("i-9", "rename foo helper", { skill: "improve-architecture" }),
    ];
    const r = checkDuplicate("clarify-docs", "rename foo helper", rows);
    expect(r.duplicate).toBe(false);
  });

  test("empty candidate title → not duplicate", () => {
    const rows = [ready("i-10", "clarify-docs: foo")];
    expect(checkDuplicate("clarify-docs", "", rows)).toEqual({ duplicate: false });
  });

  test("blocked/wip/claimed states are considered", () => {
    for (const state of ["blocked", "wip", "claimed"] as const) {
      const rows = [ready(`i-${state}`, "clarify-docs: same observation", { state })];
      const r = checkDuplicate("clarify-docs", "clarify-docs: same observation", rows);
      expect(r.duplicate).toBe(true);
    }
  });

  test("custom considerStates override default", () => {
    const rows = [ready("i-11", "clarify-docs: x", { state: "merged" })];
    const r = checkDuplicate("clarify-docs", "clarify-docs: x", rows, {
      considerStates: ["merged"],
    });
    expect(r.duplicate).toBe(true);
  });
});

describe("inferSkillFromTitle", () => {
  test("recognized skill prefix", () => {
    expect(inferSkillFromTitle("clarify-docs: foo")).toBe("clarify-docs");
    expect(inferSkillFromTitle("improve-architecture: bar")).toBe("improve-architecture");
  });
  test("unknown prefix → null", () => {
    expect(inferSkillFromTitle("unknown-skill: foo")).toBe(null);
  });
  test("no prefix → null", () => {
    expect(inferSkillFromTitle("just a title")).toBe(null);
  });
  test("case-insensitive prefix", () => {
    expect(inferSkillFromTitle("Clarify-Docs: foo")).toBe("clarify-docs");
  });
});
