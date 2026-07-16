// Verifies that a `state=merged` write reflects external truth.
//
// Two routes:
//   1. PR route — pr_url resolves to a GitHub PR whose state is MERGED.
//   2. Local-merged route — caller asserts a sha that exists on origin/main.
//
// The merge handler in bin/ledger.ts refuses to flip state=merged unless one of
// these returns ok. Pure-ish: side effects routed through injected runners so
// tests can stub.

import { parsePrUrl } from "./deploy-preview";
import { resolveProjectRepo } from "../project-repo-map";
// Re-export so downstream callers (and tests) can keep importing from
// merge-truth without knowing the canonical lives in deploy-preview.ts.
export { parsePrUrl };
export type ParsedPrUrl = { owner: string; repo: string; number: number };

export type MergeTruthOk = { ok: true; route: "pr" | "local" | "in-place"; detail: string };
export type MergeTruthFail = { ok: false; reason: string };
export type MergeTruthResult = MergeTruthOk | MergeTruthFail;

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
export type Sleep = (ms: number) => Promise<void>;

// Bounded retry schedule for transient CLOSED state (gh can report stale
// CLOSED for ~30-90s after a real merge while the API/GraphQL cache
// catches up — see analysis-1783934669.md Pattern 1). Total wall time
// before final refusal: 5s + 15s + 30s = 50s. OPEN is NOT retried — it's a
// real non-merge signal, not a stale-cache symptom.
export const PR_RETRY_BACKOFF_MS: readonly number[] = [5000, 15000, 30000];
const DEFAULT_SLEEP: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PR_NUMBER_RE = /(?:\/pull\/|^#?)(\d+)$/;
// pattern: improve-architecture-verifyprmerged-runs

export function extractPrNumber(prUrlOrNum: string | null | undefined): number | null {
  if (!prUrlOrNum) return null;
  const s = prUrlOrNum.trim();
  if (!s) return null;
  const m = s.match(PR_NUMBER_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function verifyPrMerged(
  prUrlOrNum: string | null | undefined,
  run: Runner,
  sleep: Sleep = DEFAULT_SLEEP,
): Promise<MergeTruthResult> {
  const num = extractPrNumber(prUrlOrNum);
  if (num === null) {
    return {
      ok: false,
      reason: `pr_url '${prUrlOrNum ?? ""}' does not look like a PR URL or #number. Set --pr to a GitHub PR URL (https://github.com/owner/repo/pull/N) before marking merged.`,
    };
  }
  // Pass --repo when the input was a full URL so `gh` doesn't resolve the
  // number against cwd repo's remote (cross-repo PR# collision — see
  // analysis-1780502957 Pattern 4). Bare #N or numeric input falls through
  // to cwd resolution; if your pr_url is bare, fix that upstream.
  const parsed = prUrlOrNum ? parsePrUrl(prUrlOrNum) : null;
  const ghArgs = parsed
    ? ["pr", "view", String(num), "--repo", `${parsed.owner}/${parsed.repo}`, "--json", "state", "-q", ".state"]
    : ["pr", "view", String(num), "--json", "state", "-q", ".state"];

  // Bounded retry: gh can report stale CLOSED for ~30-90s after the actual
  // merge event while the API/GraphQL node catches up. We retry CLOSED
  // up to PR_RETRY_BACKOFF_MS.length times with the configured backoff;
  // OPEN or any other non-MERGED state refuses immediately (it's a real
  // non-merge signal, not a stale-cache symptom).
  let attempts = 0;
  for (;;) {
    attempts++;
    const r = await run("gh", ghArgs);
    if (r.exitCode !== 0) {
      return { ok: false, reason: `gh pr view ${num} exited ${r.exitCode}: ${r.stdout.trim()}` };
    }
    const state = r.stdout.trim();
    if (state === "MERGED") {
      return parsed
        ? { ok: true, route: "pr", detail: `PR ${parsed.owner}/${parsed.repo}#${num} MERGED` }
        : { ok: true, route: "pr", detail: `PR #${num} MERGED (cwd-resolved, no full URL supplied)` };
    }
    // Only CLOSED is treated as transient; OPEN/anything else refuses
    // immediately. The retry budget is consumed only on CLOSED reads.
    if (state !== "CLOSED") {
      return {
        ok: false,
        reason: `PR #${num} state is '${state}', expected 'MERGED'. Wait for the PR to actually land on main before closing the row.`,
      };
    }
    const backoff = PR_RETRY_BACKOFF_MS[attempts - 1];
    if (backoff === undefined) {
      // Out of retry budget; final refusal. Surface the attempt count so
      // workers can tell the difference between a fresh flake and a guard
      // that waited through the full bounded window.
      return {
        ok: false,
        reason: `PR #${num} state is 'CLOSED' after ${attempts} attempts (bounded retry exhausted). Expected 'MERGED'. If the PR actually merged, the GitHub API/GraphQL cache may be lagging past ${PR_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0) / 1000}s.`,
      };
    }
    await sleep(backoff);
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export async function verifyLocalMerged(sha: string, run: Runner): Promise<MergeTruthResult> {
  if (!SHA_RE.test(sha)) {
    return { ok: false, reason: `--local-merged-sha '${sha}' is not a hex sha (7-40 chars).` };
  }
  const r = await run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  if (r.exitCode === 0) return { ok: true, route: "local", detail: `sha ${sha} is on origin/main` };
  if (r.exitCode === 1) {
    return { ok: false, reason: `sha ${sha} is not an ancestor of origin/main. Push the commit (or merge it) before marking merged.` };
  }
  return { ok: false, reason: `git merge-base exited ${r.exitCode}: ${r.stdout.trim()}` };
}

export async function verifyMergeTruth(args: {
  prUrl: string | null | undefined;
  localSha: string | null | undefined;
  inPlace?: boolean;
  run: Runner;
  sleep?: Sleep;
}): Promise<MergeTruthResult> {
  if (args.localSha) return verifyLocalMerged(args.localSha, args.run);
  if (args.prUrl) return verifyPrMerged(args.prUrl, args.run, args.sleep);
  // Third route: explicit in-place acknowledgement. The CLI enforces a mutex
  // between --in-place and --pr (bin/ledger.ts `update` verb), so by the time
  // we reach this branch prUrl is guaranteed null. localSha and inPlace are
  // allowed to coexist; the local-sha route is verifiable evidence, so it
  // wins when both are supplied (handled by the early-return above).
  if (args.inPlace) {
    return {
      ok: true,
      route: "in-place",
      detail: "explicit in-place acknowledgement (no PR/sha verification performed); worker must supply --evidence",
    };
  }
  return {
    ok: false,
    reason: "marking state=merged requires --pr <url-or-#num> (PR must be MERGED on GitHub), --local-merged-sha <sha> (sha must be on origin/main), or --in-place (explicit acknowledgement; supply --evidence).",
  };
}

// Default runner factory used by the CLI. Accepts the row's `project` so we
// can pin the spawned `git` / `gh` process to the project repo's cwd — when
// the caller is in `~/`, a worktree dir, or `~/trash/<ts>/`, the inherited
// CWD is not a git repo and the merge-guard fires `git merge-base` from
// nowhere, exiting 128 with "fatal: not a git repository" on stderr. The
// pre-fix runner only captured stdout, so the operator-facing refusal
// surfaced as `refused state=merged: git merge-base exited 128: ` — a
// trailing colon and nothing after it (analysis-1783937189 Pattern 1, 32
// churn events across 10 projects in 23d).
//
// Three fixes:
//   1. cwd = resolveProjectRepo(project) ?? process.cwd() (worktree reaped,
//      operator in a worktree, the cron firing from `~/` — all still find
//      the repo via the row's project field).
//   2. stderr is appended to stdout in the result, so the operator-facing
//      refusal message includes the actual reason.
//   3. 30s timeout — git merge-base is in-memory and should finish in <1s;
//      a corrupt .git could otherwise hang the validator forever.
//
// Tests inject a fake runner instead — they don't go through this factory.
export const DEFAULT_RUNNER_TIMEOUT_MS = 30_000;

export function defaultRunner(project: string | null | undefined): Runner {
  return async (cmd, args) => {
    const cwd = resolveProjectRepo(project) ?? process.cwd();
    const proc = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Race the process against a wall-clock timer. If the timer wins, kill
    // the child and surface exit 124 (timeout convention) with a descriptive
    // stdout so the validator can refuse the merge with a real reason.
    // ponytail: kill on timeout; without this a corrupt .git could hang
    // the validator forever. merge-base is in-memory; >30s = something is
    // wrong. Bump if you ever point this at a remote refspec.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), DEFAULT_RUNNER_TIMEOUT_MS);
    });
    const winner = await Promise.race([proc.exited, timeout]);
    if (timer !== null) clearTimeout(timer);
    if (winner === "timeout") {
      proc.kill();
      // Drain whatever the child wrote so the message is grounded in real
      // output, not a generic "timed out" string.
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text().catch(() => ""),
        new Response(proc.stderr).text().catch(() => ""),
      ]);
      return {
        stdout: `${stdout}${stderr}\ntimeout after ${DEFAULT_RUNNER_TIMEOUT_MS}ms`,
        exitCode: 124,
      };
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // Merge stderr into stdout so refusal messages carry the actual reason
    // (e.g. "fatal: not a git repository") instead of a trailing colon.
    const merged = stderr ? `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}` : stdout;
    return { stdout: merged, exitCode: winner };
  };
}
