// Structured-salvage-payload test.
//
// When a headless worker leaves commits but no terminal self-report, the
// reconciler advances the row to `review` with only a prose evidence string.
// A recovery worker/gate then can't cheaply recover base/head/commit-count/
// branch/exit-code/PR truth from prose. `salvage_payload_json` builds a
// machine-readable JSON blob (logged as a `salvage` event alongside the prose
// evidence) so recovery consumes structured fields, not English.
//
// Root cause (analysis-1783935600, Pattern 1 HIGH): worker output completion
// and ledger completion are separate failure domains — four trading rows
// reached `review` on salvage with no structured handoff. This pins the
// payload contract.
//
// Sourced with ARC_WORKER_SHELL_SOURCE_ONLY=1 like reconcile_decision — the
// real script, never a copy.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// salvage_payload_json <base> <head> <commits> <branch> <rc> <pr_url>
function payload(
  base: string,
  head: string,
  commits: number,
  branch: string,
  rc: number,
  prUrl: string,
): Record<string, unknown> {
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "$0" && salvage_payload_json "$1" "$2" "$3" "$4" "$5" "$6"`,
      SCRIPT,
      base,
      head,
      String(commits),
      branch,
      String(rc),
      prUrl,
    ],
    { encoding: "utf8", env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" } },
  );
  if (r.status !== 0) {
    throw new Error(`salvage_payload_json exited ${r.status}: ${r.stderr || r.stdout}`);
  }
  return JSON.parse((r.stdout ?? "").trim());
}

test("emits all salvage fields as valid JSON", () => {
  const p = payload("abc123", "def456", 4, "worker/foo", 124, "https://github.com/a-canary/x/pull/9");
  expect(p).toEqual({
    kind: "salvage",
    base: "abc123",
    head: "def456",
    commits: 4,
    branch: "worker/foo",
    exit_code: 124,
    pr_url: "https://github.com/a-canary/x/pull/9",
    reason: "commits present, no terminal self-report",
  });
});

test("null pr_url when none discovered", () => {
  const p = payload("abc123", "def456", 1, "worker/bar", 0, "");
  expect(p.pr_url).toBeNull();
});

test("commits and exit_code are JSON numbers not strings", () => {
  const p = payload("a", "b", 3, "worker/x", 137, "");
  expect(typeof p.commits).toBe("number");
  expect(typeof p.exit_code).toBe("number");
});
