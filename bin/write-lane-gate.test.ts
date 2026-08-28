import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

// write-lane-gate.sh — merge-time write-lane check (DESIGN.md invariant 7).
// Runs arc-director's shared check over the PR diff file list, mapped to the
// canonical repo root (where the writes land), not the staging worktree.

const GATE = import.meta.dir + "/write-lane-gate.sh";
const CHECKER_REPO = process.env.ARC_DIRECTOR || join(process.env.HOME!, "repos", "arc-director");

// Out-of-lane fixture root: this test file lives in a factory worktree
// (~/worktrees/**), which is outside the invariant-7 allowlist. Anything we
// git-init under it maps to an out-of-lane canonical root. Cleaned in afterAll.
const OUT_LANE_ROOT = mkdtempSync(join(import.meta.dir, "..", ".write-lane-fixtures-"));

afterAll(() => rmSync(OUT_LANE_ROOT, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

// Two-commit fixture repo: base commit on main, one file added on worker/x.
function mkRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "lane-gate-test@example.invalid");
  git(dir, "config", "user.name", "lane-gate-test");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-m", "base");
  git(dir, "checkout", "-b", "worker/x");
  writeFileSync(join(dir, "b.txt"), "diff\n");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-m", "diff file");
  return dir;
}

function runGate(repo: string, env: Record<string, string> = {}): { rc: number; stderr: string } {
  const r = spawnSync("bash", [GATE, "--project", repo], {
    encoding: "utf8",
    env: { ...process.env, LEDGER_DB: join(tmpdir(), `no-such-ledger-${Date.now()}.db`), ...env },
  });
  return { rc: r.status ?? -1, stderr: r.stderr };
}

// Temp ledger with one lane-approve note event covering `prefix`.
function approveLedger(prefix: string): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), "lane-gate-db-")), "ledger.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE issue_events (seq INTEGER PRIMARY KEY, issue_id TEXT, agent TEXT, kind TEXT, payload_md TEXT)");
  db.query("INSERT INTO issue_events (issue_id, agent, kind, payload_md) VALUES ('t', 'test', 'note', ?)").run(`lane-approve ${prefix}`);
  db.close();
  return dbPath;
}

describe("write-lane-gate", () => {
  test("passes when the canonical repo root is in-lane (/tmp)", () => {
    const repo = mkRepo(mkdtempSync(join(tmpdir(), "lane-gate-inlane-")), "repo");
    expect(runGate(repo).rc).toBe(0);
  });

  test("refuses an out-of-lane canonical root with the allowlist in stderr", () => {
    const repo = mkRepo(OUT_LANE_ROOT, "outlane-repo");
    const { rc, stderr } = runGate(repo);
    expect(rc).toBe(1);
    expect(stderr).toContain("LANE_BLOCKED");
    expect(stderr).toContain("~/repos/**");
  });

  test("a lane-approve ledger event unlocks the out-of-lane root", () => {
    const repo = mkRepo(OUT_LANE_ROOT, "approved-repo");
    const dbPath = approveLedger(OUT_LANE_ROOT);
    expect(runGate(repo, { LEDGER_DB: dbPath }).rc).toBe(0);
  });

  test("fails closed (exit 2) when the shared check is unavailable", () => {
    const repo = mkRepo(mkdtempSync(join(tmpdir(), "lane-gate-fc-")), "repo");
    expect(runGate(repo, { ARC_DIRECTOR: "/nonexistent-arc-director" }).rc).toBe(2);
  });

  test("skips (exit 0) when no base ref is resolvable", () => {
    // Single-commit repo on a branch with no main/master/origin — merge-base
    // unresolvable, nothing to gate.
    const dir = join(mkdtempSync(join(tmpdir(), "lane-gate-nobase-")), "repo");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "orphan");
    git(dir, "config", "user.email", "lane-gate-test@example.invalid");
    git(dir, "config", "user.name", "lane-gate-test");
    writeFileSync(join(dir, "a.txt"), "x\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-m", "only");
    expect(runGate(dir).rc).toBe(0);
  });

  test("checker exists in arc-director (fixture precondition)", () => {
    const r = spawnSync("bun", [join(CHECKER_REPO, "src", "policy", "check.ts")], { encoding: "utf8" });
    // No targets → usage error exit 2 proves the file runs.
    expect(r.status).toBe(2);
  });

  describe("canon_root mapping (--canon-root)", () => {
    test("plain repo maps to its own root, not its parent", () => {
      const repo = mkRepo(mkdtempSync(join(tmpdir(), "lane-gate-canon-")), "repo");
      const r = spawnSync("bash", [GATE, "--canon-root", repo], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(repo);
    });

    test("linked worktree maps to the main checkout root (merge landing point)", () => {
      const main = mkRepo(mkdtempSync(join(tmpdir(), "lane-gate-canon-wt-")), "main");
      const wt = join(dirname(main), "wt");
      git(main, "worktree", "add", "-b", "worker/y", wt);
      const r = spawnSync("bash", [GATE, "--canon-root", wt], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(main);
    });
  });
});
