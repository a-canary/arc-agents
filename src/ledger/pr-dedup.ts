// Open-PR half of ticket dedup. The ledger-row half (checkTaskDuplicate in
// hygiene-dedup.ts) catches a second ticket while the first is still an open
// row; it goes blind once that row is claimed and its work lives only in a PR.
// In the incident that motivated both halves, PR #490 and PR #495 were open
// against the same defect, so the changed files of open PRs were the signal
// that would have caught the third dispatch.
//
// Same posture as the ledger-row half: advisory only, never blocks the insert.
// A false positive strands real work; a false negative costs one duplicate
// worker.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { extractPaths } from "./hygiene-dedup";

export type OpenPr = { number: number; title: string; files: string[] };

export type PrDedupHit = {
  prNumber: number;
  prTitle: string;
  sharedPaths: string[];
};

// Pure: candidate text vs an already-fetched PR index. Path overlap only —
// no title fallback, unlike the ledger-row check. A PR title is written by a
// worker after the fact and drifts from the ticket that spawned it, so
// title similarity across the two surfaces is noise.
export function checkPrDuplicate(
  candidateText: string,
  openPrs: OpenPr[],
): PrDedupHit[] {
  const candPaths = new Set(extractPaths(candidateText));
  if (candPaths.size === 0) return [];

  const hits: PrDedupHit[] = [];
  for (const pr of openPrs) {
    const shared = pr.files.map((f) => f.toLowerCase()).filter((f) => candPaths.has(f));
    if (shared.length > 0) {
      hits.push({ prNumber: pr.number, prTitle: pr.title, sharedPaths: shared });
    }
  }
  return hits;
}

// Runner seam for `gh` — production shells out, tests inject a stub.
// Matches the GhRunner idiom in worktree-reaper.ts.
export type CmdRunner = (cmd: string, args: string[]) => { ok: boolean; out: string };
export const defaultCmdRunner: CmdRunner = (cmd, args) => {
  // Advisory runs on the synchronous create path, so a hung gh (dead network,
  // captive portal, auth prompt) must not stall the insert. Timeout => !ok =>
  // caller falls back to the stale cache, or to no hits.
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
};

export type GhRunner = (args: string[]) => { ok: boolean; out: string };
export const defaultGhRunner: GhRunner = (args) => defaultCmdRunner("gh", args);

// project → gh slug via the ~/repos/<project> convention that worker-shell.sh
// and factory.ts already use. Returns null when the repo or its origin remote
// is absent — the caller then skips the advisory.

export function slugForProject(project: string, runner: CmdRunner = defaultCmdRunner): string | null {
  const repo = join(process.env.HOME ?? "", "repos", project);
  const r = runner("git", ["-C", repo, "remote", "get-url", "origin"]);
  if (!r.ok || !r.out) return null;
  const m = r.out.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
  return m && m[1] ? m[1] : null;
}

export type PrIndexCache = { fetchedAt: number; prs: OpenPr[] };

// ponytail: one `gh pr list --json files` per TTL window, cached in a plain
// JSON file. Creation is otherwise pure-local and synchronous; this keeps the
// network cost off the common path (a burst of creates pays once). A stale
// index only weakens an advisory, so no migration/kv table is warranted.
// Upgrade path if the single call gets slow: a background refresher writing
// the same file.
const DEFAULT_TTL_SEC = 900;

export function defaultCachePath(slug: string): string {
  return join(tmpdir(), `arc-pr-index-${slug.replace(/[^\w.-]/g, "_")}.json`);
}

export function fetchOpenPrs(slug: string, runner: GhRunner = defaultGhRunner): OpenPr[] | null {
  const r = runner([
    "pr", "list", "--repo", slug, "--state", "open",
    "--limit", "100", "--json", "number,title,files",
  ]);
  if (!r.ok) return null;
  try {
    const arr = JSON.parse(r.out) as Array<{
      number?: number;
      title?: string;
      files?: Array<{ path?: string }>;
    }>;
    return arr
      .filter((p) => typeof p.number === "number")
      .map((p) => ({
        number: p.number!,
        title: p.title ?? "",
        files: (p.files ?? []).map((f) => f.path ?? "").filter(Boolean),
      }));
  } catch {
    return null;
  }
}

// Returns the cached PR index, refreshing it when older than ttlSec. Returns
// null when gh is unavailable AND no cache exists — the caller then skips the
// advisory entirely rather than reporting a false all-clear.
export function getOpenPrIndex(
  slug: string,
  opts: { ttlSec?: number; now?: number; runner?: GhRunner; cachePath?: string } = {},
): OpenPr[] | null {
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const path = opts.cachePath ?? defaultCachePath(slug);

  let cached: PrIndexCache | null = null;
  try {
    cached = JSON.parse(readFileSync(path, "utf8")) as PrIndexCache;
  } catch {
    cached = null;
  }
  if (cached && now - cached.fetchedAt < ttlSec) return cached.prs;

  const fresh = fetchOpenPrs(slug, opts.runner ?? defaultGhRunner);
  if (fresh === null) return cached?.prs ?? null;  // gh failed: stale beats nothing
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: now, prs: fresh } satisfies PrIndexCache));
  } catch {
    // cache write failure is not fatal — the advisory still runs this time
  }
  return fresh;
}
