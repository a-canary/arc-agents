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

test("tick flips engine-alias-no-work rows before hygiene rotation", async () => {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, evidence_md)
     VALUES ('recover-me', 'arc-agents', 'recover', '', 'mvp', 'blocked', 'task', 'mvp', 'build', 'engine-alias-no-work:minimax-build')`,
  );
  db.close();

  const r = await $`bun ${cli}`
    .env({
      ...process.env,
      ARC_LEDGER_DB: dbPath,
      ARC_HYGIENE_CONFIG: cfgPath,
      ARC_RECOVERY_PROBE_RC: "0",
      ARC_RECOVERY_PROBE_OUTPUT: "ok",
    })
    .quiet()
    .nothrow();

  expect(r.exitCode).toBe(0);
  const checked = new Database(dbPath);
  expect(checked.query<{ state: string }, []>("SELECT state FROM issues WHERE id='recover-me'").get()?.state).toBe("ready");
  checked.close();
});

test("recovery failure does not stop hygiene rotation", async () => {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, evidence_md)
     VALUES ('starved', 'arc-agents', 'recover', '', 'mvp', 'blocked', 'task', 'mvp', 'build', 'engine-alias-no-work:minimax-build')`,
  );
  db.close();

  // Probe returns rc=1 (starved). Sweep must not flip the row, hygiene must
  // still rotate forward.
  const r = await $`bun ${cli}`
    .env({
      ...process.env,
      ARC_LEDGER_DB: dbPath,
      ARC_HYGIENE_CONFIG: cfgPath,
      ARC_RECOVERY_PROBE_RC: "1",
      ARC_RECOVERY_PROBE_OUTPUT: "down",
    })
    .quiet()
    .nothrow();
  expect(r.exitCode).toBe(0);
  const checked = new Database(dbPath);
  expect(checked.query<{ state: string }, []>("SELECT state FROM issues WHERE id='starved'").get()?.state).toBe("blocked");
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke");
  checked.close();
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
  // exercise the wraparound, not the open-task-skip path. Keep every repo
  // active (worker events on non-hygiene rows) so the activity gate stays open.
  for (let i = 0; i < 4; i++) {
    const d = new Database(dbPath);
    const now = Math.floor(Date.now() / 1000);
    for (const repo of ["ke", "arc-agents", "arc-webui"]) seedActivityRows(d, repo, `wrap-${i}`, now);
    d.close();
    await tick();
    const m = new Database(dbPath);
    m.run(`UPDATE issues SET state='merged' WHERE type='cron' AND state!='merged'`);
    m.close();
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

// `active` (default true) also seeds a non-hygiene worker event shortly
// after the cron row so the activity gate treats the repo as active — the
// pre-gate tests model repos that have real work, which is the cadence and
// failed-dedup scenario they exercise.
function seedCron(repo: string, skill: string, createdAt: number, state = "merged", active = true) {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, created_at)
     VALUES (?, ?, ?, '', 'cron', ?, 'task', 'hygiene', 'ops', ?)`,
    [`seed-${repo}-${skill}`, repo, `hygiene: ${repo} — /${skill}`, state, createdAt],
  );
  if (active) seedActivityRows(db, repo, skill, createdAt + 3600);
  db.close();
}

function seedActivityRows(db: Database, repo: string, tag: string, ts: number) {
  const id = `act-${repo}-${tag}-${ts}`;
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, created_at)
     VALUES (?, ?, 'real work', '', 'mvp', 'ready', 'task', 'mvp', 'build', ?)`,
    [id, repo, ts],
  );
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md, ts)
     VALUES (?, 'claimed', 'arc-worker-test', 'worker claimed', ?)`,
    [id, ts],
  );
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

// ── failed-dedup (defence against exit-127 / repeated-failure churn) ───
//
// When the headless-invoke fix hasn't landed yet (or the env still doesn't
// have `pi` on PATH), every cron tick re-creates the same `(repo, skill)`
// row that just failed exit 127. The factory churns through one tmux
// session per tick per project with zero progress. The dedup halts new
// inserts when a same-`(repo, skill)` row failed within 48h and emits a
// single `note` event on the failed row's id (idempotent: re-ticks don't
// add a second note).

const FAILED_DEDUP_WINDOW_SEC = 48 * 3600; // matches bin/hygiene-tick.ts

function seedFailedCron(repo: string, skill: string, createdAt: number, id?: string) {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, created_at)
     VALUES (?, ?, ?, '', 'cron', 'failed', 'task', 'hygiene', 'ops', ?)`,
    [id ?? `failed-${repo}-${skill}-${createdAt}`, repo, `hygiene: ${repo} — /${skill}`, createdAt],
  );
  seedActivityRows(db, repo, "failed", createdAt + 3600);
  db.close();
}

test("failed-dedup: skips insert when same (repo, skill) failed within 48h and emits note on failed row", async () => {
  // Restrict the config to ke-only so the dedup blocks the entire rotation
  // and the {skipped: "failed-dedup"} shape actually emits.
  writeFileSync(
    cfgPath,
    `
skills: [improve-codebase-architecture]
repos: [ke]
`,
  );
  const recent = Math.floor(Date.now() / 1000) - 3600;
  const failedId = "failed-ke-improve-codebase-architecture-recent";
  seedFailedCron("ke", "improve-codebase-architecture", recent, failedId);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBe("failed-dedup");
  expect(out.repo).toBe("ke");
  expect(out.skill).toBe("improve-codebase-architecture");
  expect(out.existingId).toBe(failedId);

  // No new cron row was created.
  const rows = listCron();
  expect(rows.length).toBe(1);
  expect(rows[0]!.id).toBe(failedId);

  // Note was appended to the failed row's event log.
  const db = new Database(dbPath);
  const notes = db
    .query<{ payload_md: string }, [string]>(
      `SELECT payload_md FROM issue_events WHERE issue_id=? AND kind='note'`,
    )
    .all(failedId);
  db.close();
  expect(notes.length).toBe(1);
  expect(notes[0]!.payload_md).toMatch(/failed-dedup:/);
});

test("failed-dedup: does NOT skip when the most-recent failure is older than 48h", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-codebase-architecture]
repos: [ke]
`,
  );
  // Last failure 49h ago → stale → fire a new cron row.
  const stale = Math.floor(Date.now() / 1000) - FAILED_DEDUP_WINDOW_SEC - 3600;
  seedFailedCron("ke", "improve-codebase-architecture", stale);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBeUndefined();
  expect(out.repo).toBe("ke");
  expect(out.skill).toBe("improve-codebase-architecture");
  expect(listCron().length).toBe(2); // stale failed + new ready
});

test("failed-dedup: does NOT skip when the same combo last failed >48h but another skill failed <48h", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-codebase-architecture]
repos: [ke]
`,
  );
  // The rotation's pick is improve-codebase-architecture. Seed the OTHER
  // (repo, skill) failure recently; the dedup is keyed on the picked skill.
  const recent = Math.floor(Date.now() / 1000) - 3600;
  seedFailedCron("ke", "analyse-recent-sessions", recent);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBeUndefined();
  expect(out.skill).toBe("improve-codebase-architecture");
});

test("failed-dedup: does NOT skip against a merged row of the same combo (only state=failed counts)", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-codebase-architecture]
repos: [ke]
`,
  );
  // Prior merged happy-path row from 1h ago should not block a new tick —
  // merged means the previous attempt succeeded.
  const recent = Math.floor(Date.now() / 1000) - 3600;
  seedCron("ke", "improve-codebase-architecture", recent); // state defaults to "merged"

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBeUndefined();
  expect(out.skill).toBe("improve-codebase-architecture");
  expect(listCron().length).toBe(2); // merged + new ready
});

// ── activity gate ────────────────────────────────────────────────────────
//
// analysis-1787696763.md Pattern 3: low-activity repos get repeated
// zero-deliverable hygiene rows that hold a claim slot and feed the
// claim-stale-sweeper reclaim loop. Gate emission on per-repo activity:
// skip repos with no non-hygiene worker events (agent 'arc-worker-*' on a
// non-cron, non-tier-hygiene row) since the last rotation. Never-rotated
// repos stay eligible (baseline run).

test("activity gate: skips a quiet repo and picks the active one instead", async () => {
  writeFileSync(
    cfgPath,
    `skills: [improve-architecture]\nrepos: [ke, arc-agents]\n`,
  );
  // ke rotated 5 days ago with no worker activity since → quiet.
  // arc-agents rotated 4 days ago with activity after → active.
  // Without the gate, ke (older last rotation) sorts first and would be picked.
  const keLast = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", keLast, "merged", /*active=*/ false);
  const aaLast = Math.floor(Date.now() / 1000) - 86400 * 4;
  seedCron("arc-agents", "improve-architecture", aaLast); // active by default

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("arc-agents");
});

test("activity gate: emits for a repo with worker events since the last rotation", async () => {
  writeFileSync(
    cfgPath,
    `skills: [improve-architecture]\nrepos: [ke, arc-agents]\n`,
  );
  // ke rotated 5 days ago but had worker activity after → active.
  // arc-agents rotated 4 days ago with no activity since → quiet.
  const keLast = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", keLast); // active by default
  const aaLast = Math.floor(Date.now() / 1000) - 86400 * 4;
  seedCron("arc-agents", "improve-architecture", aaLast, "merged", /*active=*/ false);

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.repo).toBe("ke");
});

test("activity gate: worker events on cron and tier-hygiene rows do not count as activity", async () => {
  writeFileSync(
    cfgPath,
    `skills: [improve-architecture]\nrepos: [ke]\n`,
  );
  const last = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", last, "merged", /*active=*/ false);

  // A worker claiming the cron row itself…
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md, ts)
     VALUES ('seed-ke-improve-architecture', 'claimed', 'arc-worker-test', 'worker claimed', ?)`,
    [last + 3600],
  );
  // …and a worker event on a recent tier='hygiene' (non-cron) row…
  const hygId = "act-ke-hygiene-row";
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, created_at)
     VALUES (?, 'ke', 'hygiene followup', '', 'mvp', 'ready', 'task', 'hygiene', 'ops', ?)`,
    [hygId, last + 3600],
  );
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md, ts)
     VALUES (?, 'claimed', 'arc-worker-test', 'worker claimed', ?)`,
    [hygId, last + 3600],
  );
  db.close();

  // None of it counts → ke is quiet and the whole rotation skips.
  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBe("no-activity");
  expect(out.repos).toEqual(["ke"]);
  // No new cron row was created.
  expect(listCron().length).toBe(1);
});

test("activity gate: worker events before the last rotation do not count", async () => {
  writeFileSync(
    cfgPath,
    `skills: [improve-architecture]\nrepos: [ke]\n`,
  );
  // Activity 10 days ago, rotation 5 days ago → nothing since → quiet.
  const last = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", last, "merged", /*active=*/ false);
  const db = new Database(dbPath);
  seedActivityRows(db, "ke", "old", last - 86400 * 5);
  db.close();

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBe("no-activity");
});

test("activity gate: non-worker agents (sweeper, triage) do not count as activity", async () => {
  writeFileSync(
    cfgPath,
    `skills: [improve-architecture]\nrepos: [ke]\n`,
  );
  const last = Math.floor(Date.now() / 1000) - 86400 * 5;
  seedCron("ke", "improve-architecture", last, "merged", /*active=*/ false);

  // System churn on a non-hygiene row (reclaim-loop shape) must not keep the
  // repo eligible — that is exactly the zero-deliverable pattern we gate.
  const db = new Database(dbPath);
  const id = "act-ke-churn";
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, created_at)
     VALUES (?, 'ke', 'stuck row', '', 'mvp', 'blocked', 'task', 'mvp', 'build', ?)`,
    [id, last - 86400],
  );
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md, ts)
     VALUES (?, 'reclaimed', 'claim-stale-sweeper', 'orphan claim reset', ?)`,
    [id, last + 3600],
  );
  db.close();

  const r = await tick();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.skipped).toBe("no-activity");
});

test("failed-dedup: a second tick within 48h is idempotent (single note per failed row)", async () => {
  writeFileSync(
    cfgPath,
    `
skills: [improve-codebase-architecture]
repos: [ke]
`,
  );
  const recent = Math.floor(Date.now() / 1000) - 3600;
  const failedId = "failed-ke-improve-codebase-architecture-recent";
  seedFailedCron("ke", "improve-codebase-architecture", recent, failedId);

  await tick();
  await tick();
  await tick();

  // Still only the original failed row in the table.
  expect(listCron().length).toBe(1);

  // Still only ONE note appended (idempotency contract: re-ticks do not
  // stack notes on the failed row's event log).
  const db = new Database(dbPath);
  const notes = db
    .query<{ payload_md: string }, [string]>(
      `SELECT payload_md FROM issue_events WHERE issue_id=? AND kind='note'`,
    )
    .all(failedId);
  db.close();
  expect(notes.length).toBe(1);
});
