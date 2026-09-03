import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openWithMigrate } from "../src/ledger/db";
import {
  parseWorktreeList,
  runWorktreeHygiene,
  runGit,
  hasOpenRow,
  collectWorktreeFacts,
  findingBody,
  type RunGit,
  type WorktreeEntry,
} from "./worktree-hygiene";
import type { Database } from "bun:sqlite";

let root: string; // temp dir standing in for ~/repos
let repoDir: string; // the fixture repo (root/fixture)
let db: Database;

const git = (args: string[], cwd: string, env?: Record<string, string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });

const NOW = 1_800_000_000;
const OLD = NOW - 30 * 86400;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wt-hygiene-"));
  repoDir = join(root, "fixture");
  git(["init", "-b", "main", repoDir], root);
  git(["config", "user.email", "t@t"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  const commit = (msg: string, ts = NOW) => {
    execFileSync("sh", ["-c", `echo '${msg}' >> f.txt && git add f.txt && git commit -q -m '${msg}'`], {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_DATE: `${ts}`, GIT_COMMITTER_DATE: `${ts}` },
    });
  };
  commit("init");

  // dirty worktree, no linked row → review
  git(["worktree", "add", "-b", "wt-dirty", join(repoDir, "..", "fixture-wt-dirty")], repoDir);
  execFileSync("sh", ["-c", "echo x > stray.txt"], { cwd: join(root, "fixture-wt-dirty") });

  // unpushed worktree with a LIVE linked row → finish
  const wtFinish = join(root, "fixture-wt-finish");
  git(["worktree", "add", "-b", "wt-finish", wtFinish], repoDir);
  execFileSync("sh", ["-c", "echo y >> f.txt && git add f.txt && git commit -q -m 'ahead'"], { cwd: wtFinish });

  // abandoned worktree (old commit, terminal row) → cleanup
  const wtAbandon = join(root, "fixture-wt-abandon");
  git(["worktree", "add", "-b", "wt-abandon", wtAbandon], repoDir);
  execFileSync("sh", ["-c", "echo z >> f.txt && git add f.txt && git commit -q -m 'old'"], {
    cwd: wtAbandon,
    env: { ...process.env, GIT_AUTHOR_DATE: `${OLD}`, GIT_COMMITTER_DATE: `${OLD}` },
  });

  // prunable worktree → cleanup
  const wtPrune = join(root, "fixture-wt-prune");
  git(["worktree", "add", "-b", "wt-prune", wtPrune], repoDir);
  rmSync(wtPrune, { recursive: true, force: true });

  // clean + fresh worktree, no row → healthy (null)
  git(["worktree", "add", "-b", "wt-clean", join(root, "fixture-wt-clean")], repoDir);

  db = openWithMigrate(join(root, "ledger.db"));
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind) VALUES
     ('fixture-wt-finish-row', 'fixture', 'live row', '', 'interactive', 'claimed', 'task'),
     ('fixture-wt-abandon-row', 'fixture', 'terminal row', '', 'interactive', 'merged', 'task')`,
  );
  db.run(`UPDATE issues SET worktree_path=?, branch='wt-finish' WHERE id='fixture-wt-finish-row'`, [wtFinish]);
  db.run(`UPDATE issues SET worktree_path=?, branch='wt-abandon' WHERE id='fixture-wt-abandon-row'`, [wtAbandon]);
});

afterAll(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("parseWorktreeList", () => {
  test("parses path, branch, detached, prunable, and flags the main entry", () => {
    const porcelain = [
      "worktree /a",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /b",
      "HEAD bbb",
      "detached",
      "",
      "worktree /c",
      "HEAD ccc",
      "branch refs/heads/x",
      "prunable",
      "",
    ].join("\n");
    const wts = parseWorktreeList(porcelain);
    expect(wts).toHaveLength(3);
    expect(wts[0]).toMatchObject({ path: "/a", branch: "main", isMain: true, prunable: false });
    expect(wts[1]).toMatchObject({ path: "/b", detached: true, branch: "" });
    expect(wts[2]).toMatchObject({ path: "/c", branch: "x", prunable: true });
  });
});

describe("runWorktreeHygiene (fixture repo)", () => {
  test("files one ticket per finding with the right action class", () => {
    const summary = runWorktreeHygiene({
      db,
      repos: ["fixture"],
      repoBase: root,
      abandonDays: 14,
      maxPerRun: 10,
      run: runGit,
      now: NOW,
      log: () => {},
    });
    // 6 worktrees scanned (main + 5 planted); 4 findings (dirty→review, finish, abandon→cleanup, prune→cleanup); main+clean healthy.
    expect(summary.scanned).toBe(6);
    expect(summary.findings).toBe(4);
    expect(summary.filed).toBe(4);
    expect(summary.skipped).toBe(0);

    const titles = db
      .query<{ title: string; project: string; state: string; tier: string; pool: string }, []>(
        `SELECT title, project, state, tier, pool FROM issues WHERE type='cron' ORDER BY title`,
      )
      .all();
    expect(titles).toHaveLength(4);
    for (const t of titles) {
      expect(t.project).toBe("fixture");
      expect(t.state).toBe("ready");
      expect(t.tier).toBe("hygiene");
      expect(t.pool).toBe("ops");
    }
    expect(titles.map((t) => t.title).sort()).toEqual([
      "hygiene: fixture — worktree:cleanup:wt-abandon",
      "hygiene: fixture — worktree:cleanup:wt-prune",
      "hygiene: fixture — worktree:finish:wt-finish",
      "hygiene: fixture — worktree:review:wt-dirty",
    ]);

    // context bundle body: linked row + suggested command present
    const finish = db
      .query<{ body_md: string }, [string]>(`SELECT body_md FROM issues WHERE title=?`)
      .get("hygiene: fixture — worktree:finish:wt-finish")!;
    expect(finish.body_md).toContain("fixture-wt-finish-row");
    expect(finish.body_md).toContain("git push");
    const prune = db
      .query<{ body_md: string }, [string]>(`SELECT body_md FROM issues WHERE title=?`)
      .get("hygiene: fixture — worktree:cleanup:wt-prune")!;
    expect(prune.body_md).toContain("git worktree prune");
  });

  test("second run skips all (skip-not-stack)", () => {
    const summary = runWorktreeHygiene({
      db,
      repos: ["fixture"],
      repoBase: root,
      abandonDays: 14,
      maxPerRun: 10,
      run: runGit,
      now: NOW,
      log: () => {},
    });
    expect(summary.findings).toBe(4);
    expect(summary.filed).toBe(0);
    expect(summary.skipped).toBe(4);
    const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM issues WHERE type='cron'`).get()!.n;
    expect(n).toBe(4);
  });

  test("cap: maxPerRun limits filed, oldest last-commit first", () => {
    // Fresh db so the skip-not-stack rows above don't interfere.
    const db2 = openWithMigrate(join(root, "ledger2.db"));
    try {
      const summary = runWorktreeHygiene({
        db: db2,
        repos: ["fixture"],
        repoBase: root,
        abandonDays: 14,
        maxPerRun: 2,
        run: runGit,
        now: NOW,
        log: () => {},
      });
      expect(summary.filed).toBe(2);
      const ids = db2
        .query<{ title: string }, []>(`SELECT title FROM issues WHERE type='cron' ORDER BY id`)
        .all()
        .map((r) => r.title);
      // oldest last-commit first: the 30d-old abandoned worktree is filed before the fresh ones
      expect(ids).toContain("hygiene: fixture — worktree:cleanup:wt-abandon");
    } finally {
      db2.close();
    }
  });

  test("missing repo and bad repo are skipped, not fatal", () => {
    const logs: string[] = [];
    const summary = runWorktreeHygiene({
      db,
      repos: ["does-not-exist", "fixture"],
      repoBase: root,
      abandonDays: 14,
      maxPerRun: 10,
      run: runGit,
      now: NOW,
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => l.includes("does-not-exist"))).toBe(true);
    expect(summary.scanned).toBe(6); // fixture still swept
  });

  test("hasOpenRow ignores terminal rows", () => {
    const title = "hygiene: fixture — worktree:cleanup:wt-abandon";
    expect(hasOpenRow(db, title)).toBe(true);
    db.run(`UPDATE issues SET state='merged' WHERE title=?`, [title]);
    expect(hasOpenRow(db, title)).toBe(false);
  });
});

describe("collectWorktreeFacts unpushed count", () => {
  const entry = (over: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
    path: "/w/x",
    branch: "feature",
    detached: false,
    prunable: false,
    head: "abc",
    isMain: false,
    ...over,
  });

  function mockRun(respond: (args: string[]) => { rc: number; stdout: string } | undefined) {
    const calls: string[][] = [];
    const run: RunGit = (args) => {
      calls.push(args);
      return respond(args) ?? { rc: 1, stdout: "" };
    };
    return { run, calls };
  }

  test("upstream present + fetch ok → count @{u}..HEAD, basis post-fetch", () => {
    const { run, calls } = mockRun((args) => {
      if (args.includes("fetch")) return { rc: 0, stdout: "" };
      if (args.includes("@{u}..HEAD")) return { rc: 0, stdout: "440" };
      return undefined;
    });
    const f = collectWorktreeFacts(entry(), run, NOW);
    expect(f.unpushedCommits).toBe(440);
    expect(f.unpushedBasis).toContain("post-fetch");
    // fetch must precede the count — stale origin refs are the bug this fixes
    expect(calls.findIndex((c) => c.includes("fetch"))).toBeLessThan(
      calls.findIndex((c) => c.includes("@{u}..HEAD")),
    );
  });

  test("upstream present + fetch fails → count kept, staleness caveat in basis", () => {
    const { run } = mockRun((args) => {
      if (args.includes("fetch")) return { rc: 128, stdout: "" };
      if (args.includes("@{u}..HEAD")) return { rc: 0, stdout: "76" };
      return undefined;
    });
    const f = collectWorktreeFacts(entry(), run, NOW);
    expect(f.unpushedCommits).toBe(76);
    expect(f.unpushedBasis).toContain("stale");
  });

  test("no upstream → ahead-of-default basis, explicitly not unpushed-to-branch", () => {
    const { run } = mockRun((args) => {
      if (args.includes("fetch")) return { rc: 0, stdout: "" };
      if (args[0] === "symbolic-ref") return { rc: 0, stdout: "origin/main" };
      if (args.includes("main..HEAD")) return { rc: 0, stdout: "12" };
      return undefined; // @{u}..HEAD → rc 1
    });
    const f = collectWorktreeFacts(entry(), run, NOW);
    expect(f.unpushedCommits).toBe(12);
    expect(f.unpushedBasis).toContain("no upstream");
    expect(f.unpushedBasis).toContain("not unpushed-to-branch");
  });

  // Regression: detached used to hardcode count 0, which reads as "nothing
  // would be lost" — the exact case where commits are on no branch.
  test("detached → no fetch, counts against default branch, not a bare 0", () => {
    const { run, calls } = mockRun((args) => {
      if (args[0] === "symbolic-ref") return { rc: 0, stdout: "origin/main" };
      if (args.includes("main..HEAD")) return { rc: 0, stdout: "7" };
      return undefined;
    });
    const f = collectWorktreeFacts(entry({ branch: "", detached: true }), run, NOW);
    expect(f.unpushedCommits).toBe(7);
    expect(calls.some((c) => c.includes("fetch"))).toBe(false);
    expect(f.unpushedBasis).toContain("detached");
    expect(f.unpushedBasis).toContain("unreachable if removed");
  });

  test("detached + count fails → basis says unknown, never a misleading 0", () => {
    const { run } = mockRun(() => ({ rc: 1, stdout: "" }));
    const f = collectWorktreeFacts(entry({ branch: "", detached: true }), run, NOW);
    expect(f.unpushedBasis).toContain("unknown");
  });

  // The rendered ticket is what the operator reads. A count that failed must not
  // print as "0" there either — same misread, one layer later.
  test("count-failed detached renders 'unknown', not 0, in the ticket body", () => {
    const { run } = mockRun(() => ({ rc: 1, stdout: "" }));
    const f = collectWorktreeFacts(entry({ branch: "", detached: true }), run, NOW);
    const body = findingBody("repo", f, { action: "cleanup", reason: "r" }, { state: "none", rowId: null });
    expect(body).toContain("- unpushed commits: unknown");
    expect(body).not.toContain("- unpushed commits: 0");
  });

  test("successful count still renders the number", () => {
    const { run } = mockRun(() => ({ rc: 0, stdout: "3" }));
    const f = collectWorktreeFacts(entry({ branch: "", detached: true }), run, NOW);
    const body = findingBody("repo", f, { action: "cleanup", reason: "r" }, { state: "none", rowId: null });
    expect(body).toContain("- unpushed commits: 3");
  });

  test("HEAD not an ancestor of default → headReachable false", () => {
    const { run } = mockRun((args) => {
      if (args.includes("--is-ancestor")) return { rc: 1, stdout: "" };
      return { rc: 0, stdout: "0" };
    });
    expect(collectWorktreeFacts(entry(), run, NOW).headReachable).toBe(false);
  });

  test("ancestor check errors → treated as unreachable, not silently safe", () => {
    const { run } = mockRun((args) => {
      if (args.includes("--is-ancestor")) return { rc: 128, stdout: "" };
      return { rc: 0, stdout: "0" };
    });
    expect(collectWorktreeFacts(entry(), run, NOW).headReachable).toBe(false);
  });
});

describe("unpushed count end-to-end (real git, bare remote)", () => {
  let rroot: string;
  let cloneDir: string;
  const g = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  beforeAll(() => {
    rroot = mkdtempSync(join(tmpdir(), "wt-hygiene-remote-"));
    const remoteDir = join(rroot, "remote.git");
    g(["init", "--bare", "-b", "main", remoteDir], rroot);
    cloneDir = join(rroot, "clone");
    g(["clone", "-q", remoteDir, cloneDir], rroot);
    g(["config", "user.email", "t@t"], cloneDir);
    g(["config", "user.name", "t"], cloneDir);
    execFileSync("sh", ["-c", "echo init >> f.txt && git add -A && git commit -q -m init"], { cwd: cloneDir });
    g(["push", "-q", "origin", "main"], cloneDir);
  });

  afterAll(() => rmSync(rroot, { recursive: true, force: true }));

  test("stale cached origin ref → count matches post-fetch rev-list --count @{u}..HEAD",
    () => {
      const wt = join(rroot, "wt");
      g(["worktree", "add", "-b", "feature", wt], cloneDir);
      execFileSync("sh", ["-c", "echo a >> f.txt && git add -A && git commit -q -m c1"], { cwd: wt });
      g(["push", "-q", "-u", "origin", "feature"], wt); // sets upstream
      execFileSync("sh", ["-c", "echo b >> f.txt && git add -A && git commit -q -m c2"], { cwd: wt });
      // Corrupt the cached ref backwards (remote reset / stale cache) — the
      // pre-fix scanner would report 2 instead of the true post-fetch count.
      const initSha = g(["rev-list", "-1", "--max-parents=0", "HEAD"], cloneDir).trim();
      g(["update-ref", "refs/remotes/origin/feature", initSha], cloneDir);

      const f = collectWorktreeFacts(
        { path: wt, branch: "feature", detached: false, prunable: false, head: "", isMain: false },
        runGit,
        Date.now(),
      );
      const expected = Number(g(["rev-list", "--count", "origin/feature..HEAD"], wt).trim());
      expect(f.unpushedCommits).toBe(expected); // 1 (c2), not the stale 2
      expect(f.unpushedCommits).toBe(1);
      expect(f.unpushedBasis).toContain("post-fetch");
    });
});
