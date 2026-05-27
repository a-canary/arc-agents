// Headless reconcile-decision test.
//
// The headless worker (`pi -p`) produces no in-pane output and may not call the
// bookie before exiting. worker-shell.sh reconciles the row from worktree
// evidence after the child exits. The decision is extracted into a pure shell
// function `reconcile_decision <agent_rc> <commits_ahead>` so we can drive it
// directly without spawning a real claude/pi child or touching the ledger.
//
// We source the real worker-shell.sh with ARC_WORKER_SHELL_SOURCE_ONLY=1 (which
// returns before any claim/exec/PATH munging) and call the function. Sourcing
// the real script — not a copy — is the point: a copy could drift from prod.
//
// Regression guarded: a headless worker that COMMITS real work but EXITS
// NON-ZERO must advance to `review`, not `failed`. The old gate
// (`rc==0 && commits>0`) marked such workers `failed`, stranding salvageable
// commits (two live tasks post-restart, 2026-05-27).

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// Source worker-shell.sh in source-only mode and echo the reconcile decision
// for (rc, commits). Returns the trimmed stdout ("review" | "failed").
function decide(rc: number, commits: number): string {
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && reconcile_decision "$1" "$2"`, SCRIPT, String(rc), String(commits)],
    { encoding: "utf8", env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" } },
  );
  if (r.status !== 0) {
    throw new Error(`reconcile_decision exited ${r.status}: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

// The regression case: real commits + crash exit → must be review, not failed.
test("commits present AND non-zero exit → review (salvage the work)", () => {
  expect(decide(1, 1)).toBe("review");
  expect(decide(137, 3)).toBe("review"); // SIGKILL after committing
  expect(decide(2, 12)).toBe("review");
});

test("commits present AND clean exit → review", () => {
  expect(decide(0, 1)).toBe("review");
  expect(decide(0, 5)).toBe("review");
});

test("no commits AND clean exit → failed (nothing to review)", () => {
  expect(decide(0, 0)).toBe("failed");
});

test("no commits AND non-zero exit → failed", () => {
  expect(decide(1, 0)).toBe("failed");
  expect(decide(127, 0)).toBe("failed"); // command-not-found, produced nothing
});

// The decision must depend ONLY on commit count, never on the exit code, once
// commits exist. This pins the invariant so a future edit can't reintroduce an
// exit-code gate on the review path.
test("decision is exit-code-independent whenever commits > 0", () => {
  for (const rc of [0, 1, 2, 130, 137, 255]) {
    expect(decide(rc, 1)).toBe("review");
  }
});
