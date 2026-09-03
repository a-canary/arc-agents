#!/usr/bin/env bun
// worktree-hygiene — daily driver: scan estate worktrees, classify, file ONE
// ledger ticket per finding. TICKETS ONLY — never executes git mutations
// (operator brief 2026-07-27). Read-only w.r.t. worktree contents and local
// branches (a best-effort `git fetch` updates origin/<branch> refs so the
// unpushed count is post-fetch — see collectWorktreeFacts) + ledger writes.
//
// Config: $ARC_HYGIENE_CONFIG (yaml) or ~/.config/arc/hygiene.yaml
//   repos:  [arc-agents, ...]           (shared with hygiene-tick)
//   worktreeHygieneRepos: [ ... ]       (optional override of the scan list)
//   worktreeAbandonDays: 14             (age threshold for 'abandoned' → cleanup)
//   worktreeHygieneMaxPerRun: 10        (cap on tickets filed per run)
//   repoBase: ~/repos                   (repo name → <repoBase>/<name>)
//
// Cron (daily 04:00, PATH pinned — lesson: recovery-sweep rc=127 from bare
// 'bun' in cron's minimal PATH):
//   0 4 * * * PATH=/home/aaron/.bun/bin:/usr/local/bin:/usr/bin:/bin /home/aaron/.bun/bin/bun /home/aaron/repos/arc-agents/bin/worktree-hygiene.ts >> /home/aaron/.cache/arc-worktree-hygiene.log 2>&1
//
// Failure posture (same as recovery-sweep): one bad worktree/repo logs and
// continues; the sweep never aborts. Exit 0 ok, 2 config error.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { open, openWithMigrate, mintId } from "../src/ledger/db";
import type { Database } from "bun:sqlite";
import { classifyWorktree, suggestedCommand, type WorktreeAction } from "../src/ledger/worktree-hygiene";

function die(code: number, msg: string): never {
  process.stderr.write(`worktree-hygiene: ${msg}\n`);
  process.exit(code);
}

export function configPath(): string {
  if (process.env.ARC_HYGIENE_CONFIG) return process.env.ARC_HYGIENE_CONFIG;
  return `${process.env.HOME ?? ""}/.config/arc/hygiene.yaml`;
}

export type RunGit = (args: string[], cwd?: string) => { rc: number; stdout: string };

export const runGit: RunGit = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { rc: r.status ?? -1, stdout: r.stdout ?? "" };
};

// ---- porcelain parsing (pure) ------------------------------------------------

export type WorktreeEntry = {
  path: string;
  branch: string; // "" when detached
  detached: boolean;
  prunable: boolean;
  head: string;
  isMain: boolean;
};

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), branch: "", detached: false, prunable: false, head: "", isMain: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
    else if (line === "bare") {
      if (cur) {
        out.push(cur);
        cur = null;
      }
    }
  }
  if (cur) out.push(cur);
  if (out.length > 0) out[0]!.isMain = true;
  return out;
}

// ---- fact gathering ----------------------------------------------------------

export type CollectedFacts = {
  entry: WorktreeEntry;
  dirtyFiles: number;
  dirtyTop: string[];
  unpushedCommits: number;
  // exact count basis, for the ticket body — e.g. "@{u}..HEAD post-fetch",
  // "main..HEAD (no upstream — ahead-of-default, not unpushed-to-branch)"
  unpushedBasis: string;
  lastCommitAgeDays: number;
  // HEAD is an ancestor of the default branch. False ⇒ removing the worktree
  // orphans its commits, so the ticket must not suggest `remove --force`.
  headReachable: boolean;
};

const DAY = 86400;

// origin/HEAD → short default branch name, "main" when unresolvable.
function defaultBranch(path: string, run: RunGit): string {
  const def = run(["-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return def.rc === 0 ? def.stdout.trim().replace(/^origin\//, "") : "main";
}

export function collectWorktreeFacts(
  entry: WorktreeEntry,
  run: RunGit,
  now: number,
): CollectedFacts {
  const empty = {
    entry,
    dirtyFiles: 0,
    dirtyTop: [],
    unpushedCommits: 0,
    unpushedBasis: "(prunable — worktree dir gone)",
    lastCommitAgeDays: 0,
    headReachable: true,
  };
  if (entry.prunable) return empty; // dir gone — nothing to read

  let dirtyFiles = 0;
  let dirtyTop: string[] = [];
  let unpushedCommits = 0;
  let lastCommitAgeDays = 0;

  const status = run(["-C", entry.path, "status", "--porcelain"]);
  if (status.rc === 0) {
    const lines = status.stdout.split("\n").filter(Boolean);
    dirtyFiles = lines.length;
    dirtyTop = lines.slice(0, 10).map((l) => l.slice(3).trim());
  }

  const last = run(["-C", entry.path, "log", "-1", "--format=%ct"]);
  if (last.rc === 0) {
    const ts = Number(last.stdout.trim());
    if (Number.isFinite(ts) && ts > 0) lastCommitAgeDays = Math.max(0, Math.floor((now - ts) / DAY));
  }

  // Best-effort fetch so origin refs reflect remote state at scan time.
  // A stale cached origin/<branch> is exactly the bug that produced the
  // "76 vs actual 440" miscount. Failure never aborts the sweep — it only
  // downgrades the basis label to a staleness caveat.
  let fetched = false;
  if (!entry.detached && entry.branch) {
    fetched = run(["-C", entry.path, "fetch", "--quiet", "origin", entry.branch]).rc === 0;
  }

  let unpushedBasis: string;
  const upstream = run(["-C", entry.path, "rev-list", "--count", "@{u}..HEAD"]);
  if (upstream.rc === 0) {
    unpushedCommits = Number(upstream.stdout.trim()) || 0;
    unpushedBasis = fetched ? "@{u}..HEAD post-fetch" : "@{u}..HEAD (fetch failed — count may be stale)";
  } else if (!entry.detached && entry.branch) {
    // No upstream: fall back to the default branch. That is ahead-of-default,
    // NOT unpushed-to-branch-remote — label it so tickets don't mislead.
    const ref = defaultBranch(entry.path, run);
    const ahead = run(["-C", entry.path, "rev-list", "--count", `${ref}..HEAD`]);
    if (ahead.rc === 0) {
      unpushedCommits = Number(ahead.stdout.trim()) || 0;
      unpushedBasis = `${ref}..HEAD (no upstream — ahead-of-default, not unpushed-to-branch)`;
    } else {
      unpushedBasis = "unknown (no upstream, default-branch count failed)";
    }
  } else {
    // Detached. Reporting 0 here reads as "nothing would be lost" — but this
    // is exactly the case where commits are on NO branch and `worktree remove
    // --force` makes them unreachable, then GC'd. Count against the default
    // branch the same way the no-upstream arm above does.
    const ref = defaultBranch(entry.path, run);
    const ahead = run(["-C", entry.path, "rev-list", "--count", `${ref}..HEAD`]);
    if (ahead.rc === 0) {
      unpushedCommits = Number(ahead.stdout.trim()) || 0;
      unpushedBasis = `${ref}..HEAD (detached — commits on no branch, unreachable if removed)`;
    } else {
      unpushedBasis = "unknown (detached, default-branch count failed)";
    }
  }

  // Reachable from the default branch? Only meaningful as a *negative*: when
  // false, `worktree remove --force` orphans whatever HEAD carries. rc!=0 is
  // an errored check, not a proof of reachability — treat it as unreachable.
  const ancestor = run(["-C", entry.path, "merge-base", "--is-ancestor", "HEAD", defaultBranch(entry.path, run)]);
  const headReachable = ancestor.rc === 0;

  return { entry, dirtyFiles, dirtyTop, unpushedCommits, unpushedBasis, lastCommitAgeDays, headReachable };
}

// ---- ledger join + writer ----------------------------------------------------

const LIVE = ["ready", "claimed", "wip", "review"];
const TERMINAL = ["merged", "cancelled", "failed"];

export function linkedRowState(
  db: Database,
  path: string,
  branch: string,
): { state: "live" | "terminal" | "none"; rowId: string | null } {
  const rows = db
    .query<{ id: string; state: string }, [string, string]>(
      `SELECT id, state FROM issues WHERE worktree_path=? OR branch=? ORDER BY created_at DESC`,
    )
    .all(path, branch);
  const live = rows.find((r) => LIVE.includes(r.state));
  if (live) return { state: "live", rowId: live.id };
  const terminal = rows.find((r) => TERMINAL.includes(r.state));
  if (terminal) return { state: "terminal", rowId: terminal.id };
  return { state: "none", rowId: rows[0]?.id ?? null };
}

export function findingTitle(repo: string, action: WorktreeAction, entry: WorktreeEntry): string {
  const tail = entry.branch || (entry.path.split("/").filter(Boolean).pop() ?? entry.path);
  return `hygiene: ${repo} — worktree:${action}:${tail}`;
}

export function hasOpenRow(db: Database, title: string): boolean {
  const ph = TERMINAL.map(() => "?").join(",");
  const row = db
    .query<{ n: number }, [string, ...string[]]>(
      `SELECT COUNT(*) AS n FROM issues WHERE title=? AND state NOT IN (${ph})`,
    )
    .get(title, ...TERMINAL);
  return (row?.n ?? 0) > 0;
}

export function findingBody(
  repo: string,
  facts: CollectedFacts,
  verdict: { action: WorktreeAction; reason: string },
  linked: { state: string; rowId: string | null },
): string {
  const e = facts.entry;
  const lines = [
    `Worktree hygiene finding for \`${repo}\` (filed by bin/worktree-hygiene.ts — tickets only, no git mutations).`,
    "",
    `- path: ${e.path}${e.isMain ? " (main worktree)" : ""}`,
    `- branch: ${e.branch || "(detached)"}`,
    `- HEAD: ${e.head || "(unknown)"}`,
    `- last commit: ${facts.lastCommitAgeDays}d ago`,
    `- dirty files: ${facts.dirtyFiles}`,
  ];
  if (facts.dirtyTop.length > 0) lines.push(...facts.dirtyTop.map((p) => `  - ${p}`));
  lines.push(
    // A failed count must not render as "0" — that is the exact "nothing would be
    // lost" misread this tool exists to prevent.
    `- unpushed commits: ${facts.unpushedBasis.startsWith("unknown") ? "unknown" : facts.unpushedCommits} (basis: ${facts.unpushedBasis})`,
    `- HEAD reachable from default branch: ${facts.headReachable ? "yes" : "NO — removing this worktree orphans its commits"}`,
    `- linked row: ${linked.rowId ? `${linked.rowId} (${linked.state})` : "none"}`,
    `- classification: ${verdict.action} — ${verdict.reason}`,
  );
  const cmd = suggestedCommand(verdict.action, e.path, e.prunable, facts.headReachable);
  if (cmd) lines.push(`- suggested: \`${cmd}\``);
  return lines.join("\n");
}

export function fileFinding(
  db: Database,
  repo: string,
  facts: CollectedFacts,
  verdict: { action: WorktreeAction; reason: string },
  linked: { state: string; rowId: string | null },
): { id: string; title: string } {
  const title = findingTitle(repo, verdict.action, facts.entry);
  const seqRow = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM issues WHERE type='cron'`).get();
  const seq = String((seqRow?.n ?? 0) + 1).padStart(6, "0");
  const id = `${seq}-${mintId(db, title)}`;
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES (?, ?, ?, ?, '', 'cron', 'ready', 'task', 'hygiene', 'ops')`,
    [id, repo, title, findingBody(repo, facts, verdict, linked)],
  );
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', 'worktree-hygiene', ?)`,
    [id, title],
  );
  return { id, title };
}

// ---- sweep -------------------------------------------------------------------

export type SweepSummary = { scanned: number; findings: number; filed: number; skipped: number };

export function runWorktreeHygiene(opts: {
  db: Database;
  repos: string[];
  repoBase: string;
  abandonDays: number;
  maxPerRun: number;
  run: RunGit;
  now: number;
  log?: (msg: string) => void;
}): SweepSummary {
  const log = opts.log ?? ((m: string) => process.stderr.write(`worktree-hygiene: ${m}\n`));
  const summary: SweepSummary = { scanned: 0, findings: 0, filed: 0, skipped: 0 };

  type Candidate = { repo: string; facts: CollectedFacts; verdict: NonNullable<ReturnType<typeof classifyWorktree>>; linked: { state: string; rowId: string | null } };
  const candidates: Candidate[] = [];

  for (const repo of opts.repos) {
    const repoPath = join(opts.repoBase, repo);
    if (!existsSync(repoPath)) {
      log(`skip repo ${repo}: ${repoPath} missing`);
      continue;
    }
    const list = opts.run(["worktree", "list", "--porcelain"], repoPath);
    if (list.rc !== 0) {
      log(`skip repo ${repo}: git worktree list rc=${list.rc}`);
      continue;
    }
    for (const entry of parseWorktreeList(list.stdout)) {
      try {
        summary.scanned++;
        const facts = collectWorktreeFacts(entry, opts.run, opts.now);
        const linked = linkedRowState(opts.db, entry.path, entry.branch);
        const verdict = classifyWorktree({
          prunable: entry.prunable,
          dirtyFiles: facts.dirtyFiles,
          unpushedCommits: facts.unpushedCommits,
          lastCommitAgeDays: facts.lastCommitAgeDays,
          branch: entry.branch,
          linkedRowState: linked.state,
          abandonDays: opts.abandonDays,
          headReachable: facts.headReachable,
        });
        if (!verdict) continue;
        summary.findings++;
        candidates.push({ repo, facts, verdict, linked });
      } catch (err) {
        log(`worktree ${entry.path}: ${String(err)} (continuing)`);
      }
    }
  }

  // Cap: oldest last-commit first (largest age first).
  candidates.sort((a, b) => b.facts.lastCommitAgeDays - a.facts.lastCommitAgeDays);
  for (const c of candidates) {
    if (summary.filed >= opts.maxPerRun) break;
    const title = findingTitle(c.repo, c.verdict.action, c.facts.entry);
    if (hasOpenRow(opts.db, title)) {
      summary.skipped++;
      log(`skip (open row exists): ${title}`);
      continue;
    }
    const { id } = fileFinding(opts.db, c.repo, c.facts, c.verdict, c.linked);
    summary.filed++;
    log(`filed ${id}`);
  }
  return summary;
}

// ---- main --------------------------------------------------------------------

function main(): void {
  const path = configPath();
  if (!existsSync(path)) die(2, `config not found: ${path}`);
  const cfg = parseYaml(readFileSync(path, "utf8")) ?? {};

  const repos: string[] = Array.isArray(cfg.worktreeHygieneRepos)
    ? (cfg.worktreeHygieneRepos as string[])
    : Array.isArray(cfg.repos)
      ? (cfg.repos as string[])
      : [];
  if (repos.length === 0) die(2, "config: repos (or worktreeHygieneRepos) must be non-empty");
  const num = (v: unknown, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
  const abandonDays = num(cfg.worktreeAbandonDays, 14);
  const maxPerRun = num(cfg.worktreeHygieneMaxPerRun, 10);
  const repoBase = typeof cfg.repoBase === "string" && cfg.repoBase ? cfg.repoBase : `${process.env.HOME ?? ""}/repos`;

  const db = open();
  try {
    const summary = runWorktreeHygiene({
      db,
      repos,
      repoBase,
      abandonDays,
      maxPerRun,
      run: runGit,
      now: Math.floor(Date.now() / 1000),
    });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...summary });
    process.stdout.write(line + "\n");
    const logPath = `${process.env.HOME ?? ""}/.cache/arc-worktree-hygiene.log`;
    try {
      appendFileSync(logPath, line + "\n");
    } catch (err) {
      process.stderr.write(`worktree-hygiene: log append failed: ${String(err)}\n`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main();
