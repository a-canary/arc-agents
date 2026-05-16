import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import {
  loadConfig,
  validateHitlWrite,
  pickModulesForHitl,
  type UxConfig,
} from "./ux-config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ux-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCfg(yaml: string): string {
  const p = join(dir, "config.yaml");
  writeFileSync(p, yaml);
  return p;
}

const SAMPLE = `
modules:
  arc-tui:
    cli: "arc-tui"
    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]
    renders:
      text/markdown: native
      text/diff: native
      chart/vega-lite: ascii-degrade
      image/png: unsupported
    can_retract: true
  arc-discord:
    pusher: "arc-discord-pusher"
    implements: [ask_text, ask_confirm, notify]
    renders:
      text/markdown: native
      image/png: native
      chart/vega-lite: rasterize-png
    can_retract: false
`;

test("loadConfig parses yaml into typed UxConfig", () => {
  const cfg = loadConfig(writeCfg(SAMPLE));
  expect(Object.keys(cfg.modules).sort()).toEqual(["arc-discord", "arc-tui"]);
  expect(cfg.modules["arc-tui"]!.implements).toContain("ask_choice");
  expect(cfg.modules["arc-discord"]!.renders["image/png"]).toBe("native");
  expect(cfg.modules["arc-tui"]!.can_retract).toBe(true);
});

test("loadConfig rejects unknown verb in implements", () => {
  expect(() => loadConfig(writeCfg(`
modules:
  arc-tui:
    cli: t
    implements: [ask_text, send_telegram]
    renders: {}
    can_retract: true
`))).toThrow();
});

test("loadConfig rejects unknown render strategy", () => {
  expect(() => loadConfig(writeCfg(`
modules:
  arc-tui:
    cli: t
    implements: [ask_text]
    renders:
      text/markdown: telepathy
    can_retract: true
`))).toThrow();
});

test("loadConfig returns empty config when file missing", () => {
  const cfg = loadConfig(join(dir, "does-not-exist.yaml"));
  expect(cfg.modules).toEqual({});
});

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}
function beat(db: Database, name: string, offsetSec = 0) {
  db.run(
    `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES (?, strftime('%s','now') + ?)
     ON CONFLICT(module_name) DO UPDATE SET last_beat=excluded.last_beat`,
    [name, offsetSec],
  );
}

test("pickModulesForHitl filters config × heartbeats × verb support", () => {
  const cfg = loadConfig(writeCfg(SAMPLE));
  const db = freshDb();
  beat(db, "arc-tui");
  beat(db, "arc-discord");

  // ask_choice — only arc-tui implements it.
  const forChoice = pickModulesForHitl(db, cfg, "ask_choice");
  expect(forChoice.map((m) => m.name)).toEqual(["arc-tui"]);

  // ask_text — both implement.
  const forText = pickModulesForHitl(db, cfg, "ask_text");
  expect(forText.map((m) => m.name).sort()).toEqual(["arc-discord", "arc-tui"]);
});

test("pickModulesForHitl excludes stale heartbeats (>300s)", () => {
  const cfg = loadConfig(writeCfg(SAMPLE));
  const db = freshDb();
  beat(db, "arc-tui", -1000);
  beat(db, "arc-discord");
  const got = pickModulesForHitl(db, cfg, "ask_text");
  expect(got.map((m) => m.name)).toEqual(["arc-discord"]);
});

test("pickModulesForHitl excludes modules absent from config (alive but unknown)", () => {
  const cfg = loadConfig(writeCfg(SAMPLE));
  const db = freshDb();
  beat(db, "arc-rogue");
  beat(db, "arc-tui");
  const got = pickModulesForHitl(db, cfg, "ask_text");
  expect(got.map((m) => m.name)).toEqual(["arc-tui"]);
});

test("validateHitlWrite rejects when no module implements verb", () => {
  const cfg: UxConfig = { modules: {
    "arc-discord": {
      pusher: "x", implements: ["notify"], renders: {}, can_retract: false,
    },
  } };
  const db = freshDb();
  beat(db, "arc-discord");
  const errs = validateHitlWrite(db, cfg, { kind: "ask_choice", artifacts: [] });
  expect(errs.length).toBeGreaterThan(0);
  expect(errs[0]!.field).toBe("kind");
});

test("validateHitlWrite passes when at least one alive module implements verb", () => {
  const cfg = loadConfig(writeCfg(SAMPLE));
  const db = freshDb();
  beat(db, "arc-tui");
  const errs = validateHitlWrite(db, cfg, { kind: "ask_choice", artifacts: [] });
  expect(errs).toEqual([]);
});

test("validateHitlWrite rejects unrenderable required artifact type", () => {
  // ask_choice only on arc-tui, which marks image/png unsupported.
  const cfg = loadConfig(writeCfg(SAMPLE));
  const db = freshDb();
  beat(db, "arc-tui");
  const errs = validateHitlWrite(db, cfg, {
    kind: "ask_choice",
    artifacts: [{ type: "image/png" }],
  });
  expect(errs.some((e) => e.field === "artifacts")).toBe(true);
});

test("validateHitlWrite accepts artifact with rasterize-png strategy", () => {
  const cfg = loadConfig(writeCfg(SAMPLE));
  const db = freshDb();
  beat(db, "arc-discord");
  // arc-discord renders chart/vega-lite via rasterize-png — that counts as renderable.
  const errs = validateHitlWrite(db, cfg, {
    kind: "ask_text",
    artifacts: [{ type: "chart/vega-lite" }],
  });
  expect(errs).toEqual([]);
});
