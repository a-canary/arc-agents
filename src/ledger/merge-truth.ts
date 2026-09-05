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

// A row's scope signal for changed-file overlap checks. declaredPaths is the
// preferred signal (path prefixes/globs the task owns); branch is the
// fallback (PR head branch == row branch, or sha reachable from row branch).
// When neither is set, the route keeps legacy behaviour (state/ancestor only).
export type ScopeSignal = { declaredPaths?: string[] | null; branch?: string | null };

function hasScope(s: ScopeSignal): boolean {
  return !!(s.declaredPaths && s.declaredPaths.length) || !!(s.branch && s.branch.trim());
}

// One changed file overlaps a declared path when the file equals it, or sits
// under it as a directory prefix. A trailing '/' is optional — both 'src/led'
// and 'src/led/' match files under src/led/ but NOT a sibling 'src/ledger'
// (no partial-segment matches). Simple, deterministic, no glob engine.
// ponytail: prefix match, upgrade to minimatch if declaredPaths ever carry globs.
export function pathsOverlap(changed: string[], declared: string[]): boolean {
  return changed.some((f) =>
    declared.some((d) => {
      const p = d.trim().replace(/\/+$/, "");
      if (!p) return false;
      return f === p || f.startsWith(p + "/");
    }),
  );
}

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
  scope: ScopeSignal = {},
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
  const scoped = hasScope(scope);
  // When the row has a scope signal we need head branch + changed files too,
  // so query them in one gh call. Legacy (no-scope) rows keep the cheap
  // state-only query for backward compat.
  const jsonFields = scoped ? "state,headRefName,files" : "state";
  const baseArgs = ["pr", "view", String(num)];
  const tailArgs = scoped ? ["--json", jsonFields] : ["--json", "state", "-q", ".state"];
  const ghArgs = parsed
    ? [...baseArgs, "--repo", `${parsed.owner}/${parsed.repo}`, ...tailArgs]
    : [...baseArgs, ...tailArgs];

  // Bounded retry: gh can report stale CLOSED for ~30-90s after the actual
  // merge event while the API/GraphQL node catches up. We retry CLOSED
  // up to PR_RETRY_BACKOFF_MS.length times with the configured backoff;
  // OPEN or any other non-MERGED state refuses immediately (it's a real
  // non-merge signal, not a stale-cache symptom).
  let attempts = 0;
  let headRefName = "";
  let changedFiles: string[] = [];
  for (;;) {
    attempts++;
    const r = await run("gh", ghArgs);
    if (r.exitCode !== 0) {
      return { ok: false, reason: `gh pr view ${num} exited ${r.exitCode}: ${r.stdout.trim()}` };
    }

    let state: string;
    if (scoped) {
      let doc: { state?: string; headRefName?: string; files?: Array<{ path: string }> };
      try {
        doc = JSON.parse(r.stdout.trim());
      } catch {
        return { ok: false, reason: `gh pr view ${num} returned unparseable JSON: ${r.stdout.trim().slice(0, 200)}` };
      }
      state = (doc.state ?? "").trim();
      headRefName = (doc.headRefName ?? "").trim();
      changedFiles = (doc.files ?? []).map((f) => f.path);
    } else {
      state = r.stdout.trim();
    }

    if (state === "MERGED") break;
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

  const label = parsed ? `PR ${parsed.owner}/${parsed.repo}#${num} MERGED` : `PR #${num} MERGED (cwd-resolved, no full URL supplied)`;

  if (scoped) {
    const declared = scope.declaredPaths ?? [];
    const branch = (scope.branch ?? "").trim();
    const branchMatch = !!branch && headRefName === branch;
    const fileOverlap = declared.length > 0 && pathsOverlap(changedFiles, declared);
    if (!branchMatch && !fileOverlap) {
      return {
        ok: false,
        reason:
          `PR #${num} is MERGED but its changed files do not overlap the task's scope ` +
          `(declaredPaths=${JSON.stringify(declared)}, branch='${branch}'; ` +
          `PR head='${headRefName}', changed=${JSON.stringify(changedFiles.slice(0, 10))}). ` +
          `Citing an unrelated merged PR fails closed — target a PR whose head branch matches the row's branch ` +
          `or that touches the declared paths.`,
      };
    }
    return { ok: true, route: "pr", detail: `${label} (${branchMatch ? "branch match" : "file overlap"})` };
  }

  return { ok: true, route: "pr", detail: label };
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export async function verifyLocalMerged(
  sha: string,
  run: Runner,
  scope: ScopeSignal = {},
): Promise<MergeTruthResult> {
  if (!SHA_RE.test(sha)) {
    return { ok: false, reason: `--local-merged-sha '${sha}' is not a hex sha (7-40 chars).` };
  }
  const r = await run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  if (r.exitCode === 1) {
    return { ok: false, reason: `sha ${sha} is not an ancestor of origin/main. Push the commit (or merge it) before marking merged.` };
  }
  if (r.exitCode !== 0) {
    return { ok: false, reason: `git merge-base exited ${r.exitCode}: ${r.stdout.trim()}` };
  }

  if (!hasScope(scope)) {
    return { ok: true, route: "local", detail: `sha ${sha} is on origin/main` };
  }

  // Scope signal present: the sha must actually touch the task's paths, OR
  // be reachable from the row's branch (branch merge-base). Quoting
  // origin/main HEAD (which touches nothing task-specific) fails closed.
  const declared = scope.declaredPaths ?? [];
  const branch = (scope.branch ?? "").trim();

  let fileOverlap = false;
  if (declared.length > 0) {
    const log = await run("git", ["log", "--format=", "-n1", "--name-only", sha]);
    if (log.exitCode === 0) {
      const changed = log.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      fileOverlap = pathsOverlap(changed, declared);
    }
  }

  let branchMatch = false;
  if (!fileOverlap && branch) {
    const b = await run("git", ["merge-base", "--is-ancestor", sha, branch]);
    branchMatch = b.exitCode === 0;
  }

  if (!fileOverlap && !branchMatch) {
    return {
      ok: false,
      reason:
        `sha ${sha} is on origin/main but does not touch the task's scope ` +
        `(declaredPaths=${JSON.stringify(declared)}, branch='${branch}'). ` +
        `Quoting an origin/main-ancestor sha that changes nothing task-specific fails closed — ` +
        `cite the sha that actually modifies (overlaps) the declared paths, or that is reachable from the row's branch.`,
    };
  }
  return { ok: true, route: "local", detail: `sha ${sha} on origin/main (${fileOverlap ? "file overlap" : "branch reachable"})` };
}

export async function verifyMergeTruth(args: {
  prUrl: string | null | undefined;
  localSha: string | null | undefined;
  inPlace?: boolean;
  declaredPaths?: string[] | null;
  branch?: string | null;
  run: Runner;
  sleep?: Sleep;
}): Promise<MergeTruthResult> {
  const scope: ScopeSignal = { declaredPaths: args.declaredPaths, branch: args.branch };
  if (args.localSha) return verifyLocalMerged(args.localSha, args.run, scope);
  if (args.prUrl) return verifyPrMerged(args.prUrl, args.run, scope, args.sleep);
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
    // Kill on timeout: without this a corrupt .git could hang the validator
    // forever. merge-base is in-memory; >30s = something is wrong. Bump if
    // you ever point this at a remote refspec.
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
