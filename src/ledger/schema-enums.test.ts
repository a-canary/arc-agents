// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "bun:test";
import {
  CLASS_VALUES as SE_CLASS,
  URGENCY_VALUES as SE_URGENCY,
  TIER_VALUES,
  POOL_VALUES,
  AGENT_VALUES,
} from "./schema-enums";
import {
  CLASS_VALUES as BV_CLASS,
  URGENCY_VALUES as BV_URGENCY,
} from "./bookie-validator";

// Drift-guard. ADR 0005 enum is owned by schema-enums.ts; the
// bookie-validator adapter must re-export the SAME array object —
// not a structural copy — so a future edit to one site cannot silently diverge.
test("CLASS_VALUES is referentially identical across schema-enums and bookie-validator", () => {
  expect(BV_CLASS).toBe(SE_CLASS);
});

test("URGENCY_VALUES is referentially identical across schema-enums and bookie-validator", () => {
  expect(BV_URGENCY).toBe(SE_URGENCY);
});

// Migration 017 — new tier/pool/agent enums
test("TIER_VALUES exported and contains sentinels", () => {
  expect(TIER_VALUES).toContain("tier_unset");
  expect(TIER_VALUES).toContain("prod");
  expect(TIER_VALUES).toContain("trust");
  expect(TIER_VALUES).toContain("mvp");
  expect(TIER_VALUES).toContain("quality");
  expect(TIER_VALUES).toContain("scale");
  expect(TIER_VALUES).toContain("efficiency");
  expect(TIER_VALUES).toContain("hygiene");
  expect(TIER_VALUES.length).toBe(8);
});

test("POOL_VALUES exported and contains sentinels", () => {
  expect(POOL_VALUES).toContain("pool_unset");
  expect(POOL_VALUES).toContain("interactive");
  expect(POOL_VALUES).toContain("ops");
  expect(POOL_VALUES).toContain("build");
  expect(POOL_VALUES).toContain("explore");
  expect(POOL_VALUES.length).toBe(5);
});

test("AGENT_VALUES exported and contains sentinels", () => {
  expect(AGENT_VALUES).toContain("agent_unset");
  expect(AGENT_VALUES).toContain("director");
  expect(AGENT_VALUES).toContain("developer");
  expect(AGENT_VALUES).toContain("admin");
  expect(AGENT_VALUES).toContain("chat");
  expect(AGENT_VALUES).toContain("triage");
  expect(AGENT_VALUES).toContain("sprint");
  expect(AGENT_VALUES).toContain("bookie");
  expect(AGENT_VALUES.length).toBe(8);
});
