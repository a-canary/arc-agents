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

// ── cadence (per-(repo, skill) cooldown) ────────────────────────────────
//
// Config schema extension lets maintenance-mode repos throttle low-signal
// skills (e.g. discord-bridge, where `improve-architecture` and
// `trash-retired-files` produce "still clean" reports) while keeping the
// high-signal `analyse-recent-sessions` skill at the natural rotation rate.

function seedCron(repo: string, skill: string, createdAt: number, state = "merged") {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, created_at)
     VALUES (?, ?, ?, '', 'cron', ?, 'task', 'hygiene', 'ops', ?)`,
    [`seed-${repo}-${skill}`, repo, `hygiene: ${repo} — /${skill}`, state, createdAt],
  );
  db.close();
}

test("cadence: skips a (repo, skill) combo that fired within the cooldown window and picks the next eligible", async () => {
  writeFileSync(
    cfgPath,
    `
skills:
  - improve-architecture
  - trash-retired-files
  - analyse-recent-sessions
repos: [ke]
cadence:
  ke:
    improve-architecture: 30
    trash-retired-files: 30
`,
  );
  // Seed ke/improve-architecture AND ke/trash-retired-files 5 days ago (both
  // within 30d cooldown). analyse-recent-sessions has no cadence override.
  // n=2, rotation starts at idx 2 (= analyse) → eligible → pick.
  const recent = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", recent);
  seedCron("ke", "trash-retired-files", recent);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke");
  expect(out.skill).toBe("analyse-recent-sessions");
});

test("cadence: skips a repo whose every skill is in cooldown and falls through to the next repo", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-architecture, trash-retired-files, analyse-recent-sessions]
repos: [ke, arc-agents]
cadence:
  ke:
    improve-architecture: 30
    trash-retired-files: 30
    analyse-recent-sessions: 30
`,
  );
  // Seed all 3 (ke, skill) combos recently so every skill is in cooldown.
  const recent = Math.floor(Date.now() / 1000) - 86400 * 5;
  for (const skill of ["improve-architecture", "trash-retired-files", "analyse-recent-sessions"]) {
    seedCron("ke", skill, recent);
  }

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  // ke was the only repo with a last_created (any skill), so it sorts first,
  // but its every skill is in cooldown → fall through to arc-agents.
  expect(out.repo).toBe("arc-agents");
});

test("cadence: when every candidate repo has every skill in cooldown, output skipped:true", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-architecture, trash-retired-files]
repos: [ke, arc-agents]
cadence:
  ke:
    improve-architecture: 30
    trash-retired-files: 30
  arc-agents:
    improve-architecture: 30
    trash-retired-files: 30
`,
  );
  const recent = Math.floor(Date.now() / 1000) - 86400 * 5;
  for (const repo of ["ke", "arc-agents"]) {
    for (const skill of ["improve-architecture", "trash-retired-files"]) {
      seedCron(repo, skill, recent);
    }
  }

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBe(true);
  // No new task created.
  const db = new Database(dbPath);
  const all = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM issues WHERE type='cron'`).get();
  db.close();
  expect(all!.n).toBe(4);
});

test("cadence: a (repo, skill) combo that has never fired is not in cooldown (first run fires on schedule)", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-architecture, analyse-recent-sessions]
repos: [ke]
cadence:
  ke:
    improve-architecture: 30
`,
  );
  // No seeds. n=0, rotation starts at idx 0 = improve-architecture, which
  // is in the cadence map. lastCreatedForSkill returns null → inCooldown
  // returns false. Pick improve-architecture.
  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke");
  expect(out.skill).toBe("improve-architecture");
});

test("cadence: a skill missing from the repo's cadence map has no cooldown even if it has fired recently", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-architecture, analyse-recent-sessions]
repos: [ke]
cadence:
  ke:
    improve-architecture: 30
    # analyse-recent-sessions intentionally omitted → no cooldown
`,
  );
  // Seed both skills 5 days ago. n=2, idx 0 = improve (in cooldown), walk to
  // idx 1 = analyse (not in cadence map → inCooldown returns false → pick).
  const recent = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", recent);
  seedCron("ke", "analyse-recent-sessions", recent);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke");
  expect(out.skill).toBe("analyse-recent-sessions");
});

test("cadence: an existing (repo, skill) cron task with created_at past the cooldown window is eligible again", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-architecture, trash-retired-files]
repos: [ke]
cadence:
  ke:
    improve-architecture: 30
    trash-retired-files: 30
`,
  );
  // improve-architecture fired 31 days ago → cooldown expired → eligible.
  // trash-retired-files fired 5 days ago → in cooldown.
  // n=2, 2%2=0, startIdx=0=improve → eligible (cooldown expired) → pick.
  const old = Math.floor(Date.now() / 1000) - 86400 * 31;
  const recent = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", old);
  seedCron("ke", "trash-retired-files", recent);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke");
  expect(out.skill).toBe("improve-architecture");
});

test("cadence: config without a `cadence` key is treated as no cooldown (back-compat)", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-architecture, trash-retired-files]
repos: [ke]
`,
  );
  // Seed both skills 1 day ago (would be in cooldown if cadence were set).
  // n=2, idx 0 = improve, no cadence → inCooldown returns false → pick.
  const recent = Math.floor(Date.now() / 1000) - 86400;
  seedCron("ke", "improve-architecture", recent);
  seedCron("ke", "trash-retired-files", recent);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke");
  expect(out.skill).toBe("improve-architecture");
});

test("cadence: a zero or negative days value disables cooldown for that skill", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-architecture, trash-retired-files]
repos: [ke]
cadence:
  ke:
    improve-architecture: 0
    trash-retired-files: -1
`,
  );
  const recent = Math.floor(Date.now() / 1000) - 86400;
  seedCron("ke", "improve-architecture", recent);
  seedCron("ke", "trash-retired-files", recent);

  // n=2, idx 0 = improve (days=0 → not in cooldown) → pick.
  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skill).toBe("improve-architecture");
});
