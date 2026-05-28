// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../src/ledger/migrate";

const cli = new URL("./hygiene-tick.ts", import.meta.url).pathname;

let dir: string;
let dbPath: string;
let cfgPath: string;

const CFG = `
skills: [improve-codebase-architecture]
repos: [ke, arc-agents, arc-webui]
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hygiene-"));
  dbPath = join(dir, "t.db");
  cfgPath = join(dir, "hygiene.yaml");
  writeFileSync(cfgPath, CFG);
  const db = new Database(dbPath);
  migrate(db);
  db.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function tick() {
  return await $`bun ${cli}`
    .env({ ...process.env, ARC_LEDGER_DB: dbPath, ARC_HYGIENE_CONFIG: cfgPath })
    .quiet()
    .nothrow();
}

function listCron() {
  const db = new Database(dbPath);
  const rows = db.query<
    { id: string; title: string; project: string; type: string; kind: string; state: string; created_at: number },
    []
  >(
    `SELECT id, title, project, type, kind, state, created_at
     FROM issues WHERE type='cron' ORDER BY created_at ASC, id ASC`,
  ).all();
  db.close();
  return rows;
}

test("first tick creates one cron task for the first repo in the list", async () => {
  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke"); // starts with first repo
  expect(out.skill).toBe("improve-codebase-architecture");

  const rows = listCron();
  expect(rows.length).toBe(1);
  expect(rows[0]!.type).toBe("cron");
  expect(rows[0]!.kind).toBe("task");
  expect(rows[0]!.state).toBe("ready");
  expect(rows[0]!.project).toBe("ke");
  expect(rows[0]!.title).toContain("ke");
  expect(rows[0]!.title).toContain("improve-codebase-architecture");
});

test("successive ticks rotate through the repo list", async () => {
  await tick();
  await tick();
  await tick();
  const rows = listCron();
  expect(rows.length).toBe(3);
  expect(rows.map((r) => r.project)).toEqual(["ke", "arc-agents", "arc-webui"]);
});

test("rotation wraps around after exhausting the list", async () => {
  // Merge each task between ticks so skip-not-stack doesn't apply — we want to
  // exercise the wraparound, not the open-task-skip path.
  for (let i = 0; i < 4; i++) {
    await tick();
    const d = new Database(dbPath);
    d.run(`UPDATE issues SET state='merged' WHERE type='cron' AND state!='merged'`);
    d.close();
  }
  const rows = listCron();
  expect(rows.map((r) => r.project)).toEqual(["ke", "arc-agents", "arc-webui", "ke"]);
});

test("rotation skips a repo that already has an OPEN hygiene task (skip-not-stack)", async () => {
  await tick(); // ke
  // Don't merge it. Next tick should skip ke (already open) and pick arc-agents.
  await tick();
  const rows = listCron();
  expect(rows.map((r) => r.project)).toEqual(["ke", "arc-agents"]);
});

test("when every repo has an open hygiene task, tick exits 0 with skipped:true and creates nothing", async () => {
  await tick();
  await tick();
  await tick();
  const before = listCron().length;
  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBe(true);
  expect(listCron().length).toBe(before);
});

test("missing config exits 2", async () => {
  rmSync(cfgPath);
  const r = await tick();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("config");
});

test("empty repos list exits 2", async () => {
  writeFileSync(cfgPath, `skills: [improve-codebase-architecture]\nrepos: []\n`);
  const r = await tick();
  expect(r.exitCode).toBe(2);
});

test("body references the skill so a worker knows what to do", async () => {
  await tick();
  const db = new Database(dbPath);
  const got = db.query<{ body_md: string }, []>("SELECT body_md FROM issues WHERE type='cron'").get();
  db.close();
  expect(got!.body_md).toContain("/improve-codebase-architecture");
  expect(got!.body_md).toContain("ke");
});

test("inserted row carries migration-017 tier='hygiene' + pool='ops' (not tier_unset)", async () => {
  // Migration 017: class→tier, urgency→pool. The hygiene cron knows its own
  // classification — writing tier_unset would dump every cron task into the
  // triage backlog and bypass ADR 0005 the moment a worker tries to update it
  // via the bookie (validateBookieWrite refuses tier_unset without triage_pending).
  await tick();
  const db = new Database(dbPath);
  const got = db
    .query<{ tier: string; pool: string }, []>(
      "SELECT tier, pool FROM issues WHERE type='cron'",
    )
    .get();
  db.close();
  expect(got!.tier).toBe("hygiene");
  expect(got!.pool).toBe("ops");
});
