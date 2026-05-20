import { test, expect } from "bun:test";
import {
  CLASS_VALUES as SE_CLASS,
  URGENCY_VALUES as SE_URGENCY,
} from "./schema-enums";
import {
  CLASS_VALUES as CUS_CLASS,
  URGENCY_VALUES as CUS_URGENCY,
} from "./class-urgency-sort";
import {
  CLASS_VALUES as BV_CLASS,
  URGENCY_VALUES as BV_URGENCY,
} from "./bookie-validator";

// Drift-guard. ADR 0005 enum is owned by schema-enums.ts; both adapter
// modules must re-export the SAME array object — not a structural copy —
// so a future edit to one site cannot silently diverge.
test("CLASS_VALUES is referentially identical across all three modules", () => {
  expect(CUS_CLASS).toBe(SE_CLASS);
  expect(BV_CLASS).toBe(SE_CLASS);
});

test("URGENCY_VALUES is referentially identical across all three modules", () => {
  expect(CUS_URGENCY).toBe(SE_URGENCY);
  expect(BV_URGENCY).toBe(SE_URGENCY);
});
