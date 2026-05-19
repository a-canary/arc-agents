import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../src/ledger/migrate";

const cli = new URL("./merger-cron.ts", import.meta.url).pathname;

let dir: string;
let dbPath: string;
let cfgPath: string;
let sweepBin: string;

// UX module wired so `hitl emit` finds an alive ask_choice renderer.
const UX_MODULE = "discord";
const CONFIG_YAML = `
modules:
  ${UX_MODULE}:
    implements: [ask_choice, ask_text, ask_confirm, notify]
`;

function seedHeartbeat(path: string) {
  const db = new Database(path);
  const now = Math.floor(Date.now() / 1000);
  db.run("INSERT OR REPLACE INTO ux_heartbeats (module_name, last_beat) VALUES (?, ?)", [UX_MODULE, now]);
  db.close();
}

function writeSweepStub(path: string, lines: object[]) {
  // Stub for merger-sweep: ignores args, prints fixture JSONL.
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
  const stub = `#!/usr/bin/env bash\ncat <<'JSON'\n${body}JSON\n`;
  writeFileSync(path, stub);
  chmodSync(path, 0o755);
}

async function tick() {
  return await $`bun ${cli}`
    .env({
      ...process.env,
      ARC_LEDGER_DB: dbPath,
      ARC_CONFIG: cfgPath,
      ARC_MERGER_SWEEP_BIN: sweepBin,
    })
    .quiet()
    .nothrow();
}

function openClusterHitls() {
  const db = new Database(dbPath);
  const rows = db.query<
    { id: string; class: string; kind: string; payload: string; recommended: string | null; timeout_sec: number | null; state: string; emitted_by: string },
    []
  >(
    `SELECT id, class, kind, payload, recommended, timeout_sec, state, emitted_by
     FROM hitl_prompts WHERE emitted_by='merger-cron' ORDER BY created_at ASC`,
  ).all();
  db.close();
  return rows;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "merger-cron-"));
  dbPath = join(dir, "t.db");
  cfgPath = join(dir, "config.yaml");
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  sweepBin = join(binDir, "merger-sweep-stub.sh");

  writeFileSync(cfgPath, CONFIG_YAML);

  const db = new Database(dbPath);
  migrate(db);
  db.close();
  seedHeartbeat(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("aggregates multiple hitl_* PRs into ONE cluster HITL prompt", async () => {
  writeSweepStub(sweepBin, [
    { pr: 101, action: "hitl_conflict", reason: "merge conflict" },
    { pr: 102, action: "hitl_scope", reason: "slice-guard fail" },
    { pr: 103, action: "hitl_ambiguous", reason: "CI green but REVIEW_REQUIRED" },
    { pr: 104, action: "ready", reason: "approved + green" },
    { pr: 105, action: "defer", reason: "CI pending" },
    { pr: 106, action: "skip", reason: "draft" },
  ]);

  const r = await tick();
  expect(r.exitCode).toBe(0);

  const out = JSON.parse(r.stdout.toString());
  expect(out.hitl).toBe(3);
  expect(out.ready).toBe(1);
  expect(out.defer).toBe(1);
  expect(out.skip).toBe(1);
  expect(typeof out.hitl_id).toBe("string");

  const prompts = openClusterHitls();
  expect(prompts.length).toBe(1); // ONE cluster prompt, not three
  expect(prompts[0]!.class).toBe("taste");
  expect(prompts[0]!.kind).toBe("ask_choice");
  expect(prompts[0]!.recommended).toBe("defer-all");
  expect(prompts[0]!.timeout_sec).toBe(86400);
  expect(prompts[0]!.state).toBe("open");

  const payload = JSON.parse(prompts[0]!.payload);
  // All three flagged PRs appear in the cluster prompt body.
  expect(payload.prompt).toContain("#101");
  expect(payload.prompt).toContain("#102");
  expect(payload.prompt).toContain("#103");
  expect(payload.options).toEqual(["defer-all", "resolve-now"]);
});

test("skip-not-stack: prior cluster HITL open → today's tick is a no-op", async () => {
  writeSweepStub(sweepBin, [
    { pr: 201, action: "hitl_conflict", reason: "conflict" },
  ]);

  const first = await tick();
  expect(first.exitCode).toBe(0);
  expect(openClusterHitls().length).toBe(1);

  // Same sweep output. Without skip-not-stack we'd get a second prompt.
  const second = await tick();
  expect(second.exitCode).toBe(0);
  const out = JSON.parse(second.stdout.toString());
  expect(out.skipped).toBe(true);
  expect(out.hitl_id).toBe(openClusterHitls()[0]!.id);

  // Still exactly one cluster prompt in the table.
  expect(openClusterHitls().length).toBe(1);
});

test("after operator answers the prior cluster, next tick emits a fresh one", async () => {
  writeSweepStub(sweepBin, [
    { pr: 301, action: "hitl_scope", reason: "scope" },
  ]);

  await tick();
  const before = openClusterHitls();
  expect(before.length).toBe(1);

  // Operator answers — state leaves 'open'.
  const db = new Database(dbPath);
  db.run("UPDATE hitl_prompts SET state='answered', answer='defer-all' WHERE id=?", [before[0]!.id]);
  db.close();

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBeUndefined();
  expect(out.hitl).toBe(1);

  // Now two rows total — old answered + new open.
  expect(openClusterHitls().length).toBe(2);
});

test("no hitl_* PRs → no cluster prompt emitted", async () => {
  writeSweepStub(sweepBin, [
    { pr: 401, action: "ready", reason: "go" },
    { pr: 402, action: "defer", reason: "wait" },
  ]);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.hitl).toBe(0);
  expect(out.hitl_id).toBeNull();
  expect(openClusterHitls().length).toBe(0);
});

test("empty PR queue → exits 0 with no prompt", async () => {
  writeSweepStub(sweepBin, []);
  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.hitl).toBe(0);
  expect(out.ready).toBe(0);
  expect(openClusterHitls().length).toBe(0);
});

test("merger-sweep failure → exits 1", async () => {
  const failStub = `#!/usr/bin/env bash\necho "boom" >&2\nexit 1\n`;
  writeFileSync(sweepBin, failStub);
  chmodSync(sweepBin, 0o755);

  const r = await tick();
  expect(r.exitCode).toBe(1);
});
