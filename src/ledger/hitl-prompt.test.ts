// Tests for the consolidated HITL prompt insert + validation module.
// See src/ledger/hitl-prompt.ts. Both bin/arc-ux.ts and bin/ledger.ts's
// `hitl emit` verb route through this module so the Zod payload validator
// and the bookie's pre-write checks (alive-module + render-capability) run
// on every code path that writes hitl_prompts rows.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { loadConfig } from "./ux-config";
import { buildPayload, insertHitlPrompt } from "./hitl-prompt";

let dir: string;
let dbPath: string;
let cfgPath: string;

const FULL_CFG = `
modules:
  arc-tui:
    cli: arc-tui
    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]
    renders:
      text/markdown: native
      text/diff: native
      image/png: ascii-degrade
      chart/vega-lite: ascii-degrade
      diagram/mermaid: ascii-degrade
      table/rows: native
    can_retract: true
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hitl-prompt-"));
  dbPath = join(dir, "t.db");
  cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, FULL_CFG);
  const db = new Database(dbPath);
  migrate(db);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Database {
  return new Database(dbPath);
}

function heartbeat(db: Database, name: string): void {
  db.run(
    `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES (?, strftime('%s','now'))
     ON CONFLICT(module_name) DO UPDATE SET last_beat=excluded.last_beat`,
    [name],
  );
}

// --- buildPayload --------------------------------------------------------

test("buildPayload ask_text returns validated payload with empty artifacts", () => {
  const p = buildPayload("ask_text", { prompt: "hi" });
  expect(p).toEqual({ prompt: "hi", artifacts: [] });
});

test("buildPayload ask_choice returns validated payload with options", () => {
  const p = buildPayload("ask_choice", { prompt: "pick", options: ["a", "b"] });
  expect(p).toEqual({ prompt: "pick", options: ["a", "b"], artifacts: [] });
});

test("buildPayload ask_choice with <2 options throws (schema requires min(2))", () => {
  expect(() =>
    buildPayload("ask_choice", { prompt: "x", options: ["only-one"] }),
  ).toThrow();
});

test("buildPayload ask_choice with empty options throws", () => {
  expect(() => buildPayload("ask_choice", { prompt: "x", options: [] })).toThrow();
});

test("buildPayload ask_text with empty prompt throws (schema requires min(1))", () => {
  expect(() => buildPayload("ask_text", { prompt: "" })).toThrow();
});

test("buildPayload notify returns validated payload with default level", () => {
  const p = buildPayload("notify", { message: "hello" });
  expect(p).toEqual({ message: "hello", level: "info" });
});

test("buildPayload notify with explicit level", () => {
  const p = buildPayload("notify", { message: "hello", level: "warn" }) as { level: string };
  expect(p.level).toBe("warn");
});

test("buildPayload show_artifact requires at least one artifact", () => {
  expect(() => buildPayload("show_artifact", { artifacts: [] })).toThrow();
});

test("buildPayload show_artifact accepts caption + artifacts", () => {
  const p = buildPayload("show_artifact", {
    caption: "look",
    artifacts: [{ type: "text/markdown", inline: "hi" }],
  }) as { artifacts: unknown[] };
  expect(p.artifacts.length).toBe(1);
});

// --- insertHitlPrompt ----------------------------------------------------

test("insertHitlPrompt inserts row + deliveries when alive module present", () => {
  const db = openDb();
  heartbeat(db, "arc-tui");
  const cfg = loadConfig(cfgPath);
  const payload = buildPayload("ask_choice", { prompt: "pick", options: ["a", "b"] });
  const { id } = insertHitlPrompt(db, {
    kind: "ask_choice",
    cls: "taste",
    payload,
    recommended: "a",
    strategy: "forward_fix",
    timeoutSec: 60,
    cfg,
  });
  expect(typeof id).toBe("string");
  const row = db
    .query<{ kind: string; class: string; state: string; recommended: string }, [string]>(
      "SELECT kind, class, state, recommended FROM hitl_prompts WHERE id=?",
    )
    .get(id);
  expect(row).not.toBeNull();
  expect(row!.kind).toBe("ask_choice");
  expect(row!.class).toBe("taste");
  expect(row!.state).toBe("open");
  expect(row!.recommended).toBe("a");
  const dels = db
    .query<{ module_name: string; state: string }, [string]>(
      "SELECT module_name, state FROM hitl_deliveries WHERE prompt_id=?",
    )
    .all(id);
  expect(dels.length).toBe(1);
  expect(dels[0]!.module_name).toBe("arc-tui");
  db.close();
});

test("insertHitlPrompt throws when no alive module implements the kind", () => {
  const db = openDb();
  // No heartbeat -> arc-tui counts as stale -> no candidates.
  const cfg = loadConfig(cfgPath);
  const payload = buildPayload("ask_text", { prompt: "hi" });
  expect(() =>
    insertHitlPrompt(db, {
      kind: "ask_text",
      cls: "taste",
      payload,
      recommended: "ok",
      strategy: "forward_fix",
      timeoutSec: 60,
      cfg,
    }),
  ).toThrow(/no alive UX module/);
  const n = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_prompts").get();
  expect(n!.c).toBe(0);
  db.close();
});

test("insertHitlPrompt persists expires_at = now + timeoutSec", () => {
  const db = openDb();
  heartbeat(db, "arc-tui");
  const cfg = loadConfig(cfgPath);
  const payload = buildPayload("ask_choice", { prompt: "q", options: ["a", "b"] });
  const before = Math.floor(Date.now() / 1000);
  const { id } = insertHitlPrompt(db, {
    kind: "ask_choice",
    cls: "taste",
    payload,
    recommended: "a",
    strategy: "forward_fix",
    timeoutSec: 90,
    cfg,
  });
  const after = Math.floor(Date.now() / 1000);
  const row = db
    .query<{ expires_at: number | null; timeout_sec: number | null }, [string]>(
      "SELECT expires_at, timeout_sec FROM hitl_prompts WHERE id=?",
    )
    .get(id);
  expect(row!.timeout_sec).toBe(90);
  expect(row!.expires_at!).toBeGreaterThanOrEqual(before + 90);
  expect(row!.expires_at!).toBeLessThanOrEqual(after + 90);
  db.close();
});
