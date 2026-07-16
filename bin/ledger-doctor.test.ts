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
  project_misroutes: { id: string; suspected_project: string }[];
}> {
  const r = await $`bun ${cli} doctor --db ${db} --worktree-root ${root} --json ${extra}`.quiet();
  return JSON.parse(r.stdout.toString());
}

async function doctorExit(db: string, root: string, extra: string[] = []): Promise<{
  exitCode: number;
  stdout: string;
}> {
  const r = await $`bun ${cli} doctor --db ${db} --worktree-root ${root} --json ${extra}`.quiet().nothrow();
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
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

test("doctor: mergeable_worktrees scoped to --worktree-root", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();

    const repo = mkdtempSync(join(tmpdir(), "doctor-scope-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "doctor-outside-"));
    try {
      await $`git -C ${repo} init -q -b main`.quiet();
      await $`git -C ${repo} config user.email t@t`.quiet();
      await $`git -C ${repo} config user.name t`.quiet();
      writeFileSync(join(repo, "f"), "x");
      await $`git -C ${repo} add f`.quiet();
      await $`git -C ${repo} commit -q -m init`.quiet();

      // Two worktrees branched off main; then main advances PAST both, so each
      // HEAD sits strictly behind the tip — the merged shape doctor reaps. This
      // test isolates the --worktree-root SCOPING rule, so both are equally
      // mergeable-by-state and only their location should differ.
      const inside = join(root, "arc-agents-inside");
      await $`git -C ${repo} worktree add -q ${inside} -b feat-inside`.quiet();
      const outside = join(outsideRoot, "arc-agents-outside");
      await $`git -C ${repo} worktree add -q ${outside} -b feat-outside`.quiet();
      // main moves forward; both worktrees are now behind the advanced tip.
      writeFileSync(join(repo, "g"), "y");
      await $`git -C ${repo} add g`.quiet();
      await $`git -C ${repo} commit -q -m advance`.quiet();

      // INSIDE the scan root → mergeable. OUTSIDE → excluded purely by scoping,
      // even though its state would otherwise qualify.
      const out = await doctor(db, root);
      expect(out.worktree_scan_error).toBeNull();
      const paths = out.mergeable_worktrees.map((w) => w.path);
      expect(paths).toContain(inside);
      expect(paths).not.toContain(outside);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
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

test("doctor --strict: exits 0 on clean ledger", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const r = await doctorExit(db, root, ["--strict"]);
    expect(r.exitCode).toBe(0);
  } finally {
    cleanup();
  }
});

test("doctor --strict: exits 1 when phantom claim present", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const sqliteDb = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    // Phantom per doctor's SQL: claimed_by IS NOT NULL AND state NOT IN ('claimed','wip').
    sqliteDb.run(`
      INSERT INTO issues (id, project, body_md, kind, type, title, state, claimed_by, claimed_at, created_at, updated_at)
      VALUES ('phantom-1', 'p', '', 'task', 'mvp', 't', 'ready', 'w1', ?, ?, ?)
    `, [now, now, now]);
    sqliteDb.close();

    const r = await doctorExit(db, root, ["--strict"]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.phantom_claims.length).toBe(1);
    expect(out.phantom_claims[0].id).toBe("phantom-1");
  } finally {
    cleanup();
  }
});

test("doctor --strict: exits 1 when stale claim present", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const sqliteDb = new Database(db);
    const tenHoursAgo = Math.floor(Date.now() / 1000) - 10 * 3600;
    sqliteDb.run(`
      INSERT INTO issues (id, project, body_md, kind, type, title, state, claimed_by, claimed_at, created_at, updated_at)
      VALUES ('stale-strict', 'p', '', 'task', 'mvp', 't', 'wip', 'w1', ?, ?, ?)
    `, [tenHoursAgo, tenHoursAgo, tenHoursAgo]);
    sqliteDb.close();

    const r = await doctorExit(db, root, ["--strict", "--stale-hours", "4"]);
    expect(r.exitCode).toBe(1);
  } finally {
    cleanup();
  }
});

test("doctor --strict: exits 1 when untracked worktree dir present", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();

    const repo = mkdtempSync(join(tmpdir(), "strict-untracked-"));
    try {
      await $`git -C ${repo} init -q -b main`.quiet();
      await $`git -C ${repo} config user.email t@t`.quiet();
      await $`git -C ${repo} config user.name t`.quiet();
      writeFileSync(join(repo, "f"), "x");
      await $`git -C ${repo} add f`.quiet();
      await $`git -C ${repo} commit -q -m init`.quiet();

      // Doctor anchors `git worktree list` to a sample matching dir; that dir
      // must itself be a git worktree, otherwise the scan can't compare.
      const registered = join(root, "arc-agents-real");
      await $`git -C ${repo} worktree add -q ${registered} -b feat-real`.quiet();

      const orphan = join(root, "arc-agents-orphan");
      mkdirSync(orphan);
      writeFileSync(join(orphan, "scratch"), "x");

      const r = await doctorExit(db, root, ["--strict"]);
      expect(r.exitCode).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out.untracked_worktree_dirs).toContain(orphan);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("doctor --strict: mergeable_worktrees alone does NOT trigger non-zero exit", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();

    const repo = mkdtempSync(join(tmpdir(), "strict-mergeable-"));
    try {
      await $`git -C ${repo} init -q -b main`.quiet();
      await $`git -C ${repo} config user.email t@t`.quiet();
      await $`git -C ${repo} config user.name t`.quiet();
      writeFileSync(join(repo, "f"), "x");
      await $`git -C ${repo} add f`.quiet();
      await $`git -C ${repo} commit -q -m init`.quiet();

      // A genuinely-merged worktree: branch off main, then advance main PAST it
      // so the worktree's HEAD sits STRICTLY behind main's tip. Only this shape
      // is mergeable — doctor reaps worktrees whose work already landed. (Tracked
      // by git, so NOT an untracked dir.)
      const inside = join(root, "arc-agents-mergeable");
      await $`git -C ${repo} worktree add -q ${inside} -b feat-mergeable`.quiet();
      // main moves forward; the worktree is now behind the advanced tip.
      writeFileSync(join(repo, "g"), "y");
      await $`git -C ${repo} add g`.quiet();
      await $`git -C ${repo} commit -q -m advance`.quiet();

      // A FRESH worktree at HEAD == main's tip must NOT be flagged mergeable —
      // it has produced nothing to merge, and reaping it (under ARC_AUTO_PRUNE)
      // would delete a just-booted worker's checkout out from under it. This is
      // the exact regression the strict-ancestor guard prevents.
      const fresh = join(root, "arc-agents-fresh");
      await $`git -C ${repo} worktree add -q ${fresh} -b feat-fresh`.quiet();

      const r = await doctorExit(db, root, ["--strict"]);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      const mergeablePaths = out.mergeable_worktrees.map((w: { path: string }) => w.path);
      expect(mergeablePaths).toContain(inside);
      expect(mergeablePaths).not.toContain(fresh);
      expect(out.untracked_worktree_dirs).toEqual([]);
      expect(out.phantom_claims).toEqual([]);
      expect(out.stale_claims).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("doctor: project_misroutes flags default-project task naming a sibling repo", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();

    const reposRoot = mkdtempSync(join(tmpdir(), "repos-root-"));
    try {
      mkdirSync(join(reposRoot, "arc-agents"));
      mkdirSync(join(reposRoot, "arc-webui"));

      const sqliteDb = new Database(db);
      const now = Math.floor(Date.now() / 1000);
      sqliteDb.run(`
        INSERT INTO issues (id, project, body_md, kind, type, title, state, created_at, updated_at)
        VALUES ('mis-1', '', 'wire up the arc-webui viewport shell', 'task', 'mvp', 't', 'ready', ?, ?)
      `, [now, now]);
      sqliteDb.close();

      const out = await doctor(db, root, ["--repos-root", reposRoot]);
      expect(out.project_misroutes).toEqual([{ id: "mis-1", suspected_project: "arc-webui" }]);
    } finally {
      rmSync(reposRoot, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("doctor: project_misroutes ignores rows with no sibling-repo mention", async () => {
  const { db, root, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();

    const reposRoot = mkdtempSync(join(tmpdir(), "repos-root-"));
    try {
      mkdirSync(join(reposRoot, "arc-agents"));
      mkdirSync(join(reposRoot, "arc-webui"));

      const sqliteDb = new Database(db);
      const now = Math.floor(Date.now() / 1000);
      sqliteDb.run(`
        INSERT INTO issues (id, project, body_md, kind, type, title, state, created_at, updated_at)
        VALUES ('ok-1', '', 'improve the ledger doctor check', 'task', 'mvp', 't', 'ready', ?, ?)
      `, [now, now]);
      sqliteDb.close();

      const out = await doctor(db, root, ["--repos-root", reposRoot]);
      expect(out.project_misroutes).toEqual([]);
    } finally {
      rmSync(reposRoot, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

