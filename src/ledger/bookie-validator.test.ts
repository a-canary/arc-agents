import { test, expect } from "bun:test";
import {
  validateCreate,
  validateStateTransition,
  validateModuleName,
  registeredModuleNames,
  KIND_VALUES,
  TYPE_VALUES,
} from "./bookie-validator";
import { loadConfig } from "./ux-config";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ADR 0002 module registry validator
const REGISTRY = ["arc-tui", "arc-discord", "arc-chat", "arc-webui"] as const;

test("validateModuleName rejects null/undefined", () => {
  expect(validateModuleName(null, REGISTRY)).toHaveLength(1);
  expect(validateModuleName(undefined, REGISTRY)).toHaveLength(1);
});

test("validateModuleName rejects empty/whitespace", () => {
  expect(validateModuleName("", REGISTRY)).toHaveLength(1);
  expect(validateModuleName("   ", REGISTRY)).toHaveLength(1);
});

test("validateModuleName rejects unknown module with registry list in message", () => {
  const errs = validateModuleName("bogus", REGISTRY);
  expect(errs).toHaveLength(1);
  expect(errs[0].message).toContain("bogus");
  expect(errs[0].message).toContain("arc-tui");
  expect(errs[0].message).toContain("ADR 0002");
});

test("validateModuleName accepts every registered module", () => {
  for (const m of REGISTRY) {
    expect(validateModuleName(m, REGISTRY)).toEqual([]);
  }
});

test("validateModuleName field tag flows through to error", () => {
  const errs = validateModuleName("nope", REGISTRY, "source_module");
  expect(errs[0].field).toBe("source_module");
});

test("validateModuleName empty registry still rejects with hint", () => {
  const errs = validateModuleName("arc-tui", []);
  expect(errs).toHaveLength(1);
  expect(errs[0].message).toContain("none registered");
});

test("registeredModuleNames + loadConfig: accepts each module from ux-config.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bookie-validator-modreg-"));
  try {
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(
      cfgPath,
      `modules:\n  arc-tui:\n    cli: arc-tui\n    implements: [ask_text]\n  arc-discord:\n    pusher: arc-discord-pusher\n    implements: [notify]\n  arc-webui:\n    implements: [show_artifact]\n`,
    );
    const cfg = loadConfig(cfgPath);
    const names = registeredModuleNames(cfg);
    expect(names.sort()).toEqual(["arc-discord", "arc-tui", "arc-webui"]);
    for (const n of names) {
      expect(validateModuleName(n, names, "source_module")).toEqual([]);
    }
    expect(validateModuleName("not-registered", names, "deliveries.module")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
