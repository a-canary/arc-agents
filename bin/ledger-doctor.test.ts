import { test, expect } from "bun:test";
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function fresh(): { db: string; root: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-doctor-"));
  const db = join(dir, "t.db");
  const root = join(dir, "worktrees");
  mkdirSync(root);
  return { db, root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function doctor(db: string, root: string, extra: string[] = []): Promise<{
  stale_hours: number;
  worktree_root: string;
  repo_prefix: string;
  phantom_claims: { id: string; state: string; claimed_by: string }[];
  stale_claims: { id: string; age_hours: number }[];
  state_counts: { state: string; n: number }[];
  untracked_worktree_dirs: string[];
  mergeable_worktrees: { path: string; branch: string | null }[];
  worktree_scan_error: string | null;
}> {
  const r = await $`bun ${cli} doctor --db ${db} --worktree-root ${root} --json ${extra}`.quiet();
  return JSON.parse(r.stdout.toString());
}

test("doctor: empty ledger reports zero anomalies", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const out = await doctor(db, root);
    expect(out.phantom_claims).toEqual([]);
    expect(out.stale_claims).toEqual([]);
    expect(out.state_counts).toEqual([]);
    expect(out.untracked_worktree_dirs).toEqual([]);
    expect(out.mergeable_worktrees).toEqual([]);
    expect(out.stale_hours).toBe(4);
    expect(out.repo_prefix).toBe("arc-agents-");
  } finally {
    cleanup();
  }
});

test("doctor: detects stale claim past --stale-hours cutoff", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    // Insert a wip row whose claimed_at is 10hr old.
    const sqliteDb = new Database(db);
    const tenHoursAgo = Math.floor(Date.now() / 1000) - 10 * 3600;
    sqliteDb.run(`
      INSERT INTO issues (id, project, body_md, kind, type, title, state, claimed_by, claimed_at, created_at, updated_at)
      VALUES ('stale-1', 'p', '', 'task', 'mvp', 't', 'wip', 'w1', ?, ?, ?)
    `, [tenHoursAgo, tenHoursAgo, tenHoursAgo]);
    sqliteDb.close();

    const out = await doctor(db, root, ["--stale-hours", "4"]);
    expect(out.stale_claims.length).toBe(1);
    expect(out.stale_claims[0]!.id).toBe("stale-1");
    expect(out.stale_claims[0]!.age_hours).toBeGreaterThan(9);
  } finally {
    cleanup();
  }
});

test("doctor: --stale-hours suppresses fresh claims", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const sqliteDb = new Database(db);
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    sqliteDb.run(`
      INSERT INTO issues (id, project, body_md, kind, type, title, state, claimed_by, claimed_at, created_at, updated_at)
      VALUES ('fresh-1', 'p', '', 'task', 'mvp', 't', 'wip', 'w1', ?, ?, ?)
    `, [oneHourAgo, oneHourAgo, oneHourAgo]);
    sqliteDb.close();

    const out = await doctor(db, root, ["--stale-hours", "4"]);
    expect(out.stale_claims).toEqual([]);
  } finally {
    cleanup();
  }
});

test("doctor: state_counts tallies all states", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const sqliteDb = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    for (const [id, state] of [
      ["a", "merged"], ["b", "merged"], ["c", "ready"], ["d", "blocked"],
    ] as const) {
      sqliteDb.run(`
        INSERT INTO issues (id, project, body_md, kind, type, title, state, created_at, updated_at)
        VALUES (?, 'p', '', 'task', 'mvp', 't', ?, ?, ?)
      `, [id, state, now, now]);
    }
    sqliteDb.close();

    const out = await doctor(db, root);
    const counts = Object.fromEntries(out.state_counts.map((r) => [r.state, r.n]));
    expect(counts.merged).toBe(2);
    expect(counts.ready).toBe(1);
    expect(counts.blocked).toBe(1);
  } finally {
    cleanup();
  }
});

test("doctor: surfaces orphan worktree dirs not in git worktree list", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();

    // Set up a tiny git repo + a registered worktree alongside an orphan dir.
    const repo = mkdtempSync(join(tmpdir(), "doctor-repo-"));
    try {
      await $`git -C ${repo} init -q -b main`.quiet();
      await $`git -C ${repo} config user.email t@t`.quiet();
      await $`git -C ${repo} config user.name t`.quiet();
      writeFileSync(join(repo, "f"), "x");
      await $`git -C ${repo} add f`.quiet();
      await $`git -C ${repo} commit -q -m init`.quiet();

      // Registered worktree under the scan root.
      const registered = join(root, "arc-agents-real");
      await $`git -C ${repo} worktree add -q ${registered} -b feat-real`.quiet();

      // Orphan dir with the matching prefix but no git registration.
      const orphan = join(root, "arc-agents-orphan");
      mkdirSync(orphan);
      writeFileSync(join(orphan, "scratch"), "x");

      const out = await doctor(db, root);
      expect(out.worktree_scan_error).toBeNull();
      expect(out.untracked_worktree_dirs).toContain(orphan);
      expect(out.untracked_worktree_dirs).not.toContain(registered);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("doctor: missing worktree root reports scan error", async () => {
  const { db, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const out = await doctor(db, "/nonexistent/path/doctor-test");
    expect(out.worktree_scan_error).toContain("not found");
    expect(out.untracked_worktree_dirs).toEqual([]);
  } finally {
    cleanup();
  }
});
