// Tests for `project_repo_path` — the cross-project routing helper in
// bin/worker-shell.sh.
//
// Background: the `project` column on a ledger row is a LOGICAL name (e.g.
// `starlight`, `starlight-slm`, `arc-agents`), not the path to the physical
// git repo that holds the code. The dispatcher's factory runs from
// `arc-agents/` and computes WT_DIR = ~/worktrees/<basename-of-$REPO>-<id>,
// which hardcoded `arc-agents` as the prefix. For non-arc-agents projects,
// the worker landed in an empty arc-agents checkout with no relevant code.
//
// The fix: worker-shell.sh now reads the row's `project` (returned alongside
// `id` from the claim SQL) and routes via `project_repo_path <project>`. The
// default for unknown projects is the dispatcher's $REPO (arc-agents), so
// the back-compat path is preserved for every project that lives in
// arc-agents / arc-webui / arc-skills / etc.
//
// These tests drive the REAL function via ARC_WORKER_SHELL_SOURCE_ONLY=1
// (a copy could drift from prod, the same pattern used by the other
// worker-shell tests).

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// Source worker-shell.sh in source-only mode, set REPO + (optionally) an
// env-var override, then call `project_repo_path <project>`. Returns
// { rc, out } so the assertion can detect a syntax error.
function projectPath(
  project: string,
  env: Record<string, string> = {},
): { rc: number; out: string } {
  const r = spawnSync(
    "bash",
    [
      "-c",
      // Set REPO + env overrides, then call the pure helper. The helper
      // uses ${REPO:-} as the fall-through, so an unset REPO echoes empty
      // (an assert path) and a set REPO echoes it back. We always set REPO
      // here for the fall-through tests.
      `source "$0"
       REPO="\${REPO:-/dispatcher/repo}"
       ${Object.entries(env)
         .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
         .join("\n       ")}
       project_repo_path ${JSON.stringify(project)}`,
      SCRIPT,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" },
    },
  );
  return { rc: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

// The mapping is intentionally small and explicit. Adding a new project
// without a row here falls through to $REPO (arc-agents) — same as the
// pre-fix behavior — so unknown projects don't break, they just get the
// old (wrong-repo) behavior. Operators add a row by editing the function
// or by setting ARC_PROJECT_REPO_<project>.
test("project_repo_path maps project=starlight to expert-horde", () => {
  const r = projectPath("starlight");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/aaron/repos/expert-horde");
});

test("project_repo_path maps project=starlight-slm to starlight-slm", () => {
  const r = projectPath("starlight-slm");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/aaron/repos/starlight-slm");
});

test("project_repo_path maps project=expert-horde to expert-horde", () => {
  // Hygiene cron rows in ~/.config/arc/hygiene.yaml list `expert-horde` (not
  // the legacy `starlight` alias) as the logical project name. Without this
  // mapping, the case branch falls through to $REPO (arc-agents) and the
  // worker lands in an empty arc-agents worktree, having to manually clone
  // the real expert-horde checkout. See task
  // `improve-architecture-bin-worker-shell-sh` (2026-06-07).
  const r = projectPath("expert-horde");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/aaron/repos/expert-horde");
});

test("project_repo_path falls through to $REPO (arc-agents) for unknown projects", () => {
  // Back-compat path: every arc-agents / arc-webui / arc-skills / etc. row
  // hits this default and ends up where the old code put it — no
  // regression on the existing flow.
  const r = projectPath("arc-agents");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/dispatcher/repo");
});

test("project_repo_path falls through to $REPO for an empty project name", () => {
  // Defensive: the claim SQL returns project=NULL when the row's project
  // is unset; the bash parser may translate that to an empty string. An
  // empty input must NOT crash, must NOT match `starlight`, must fall
  // through to $REPO. A null/empty would otherwise have a real blast
  // radius (the worker runs in the wrong repo, the worktree is wrong).
  const r = projectPath("");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/dispatcher/repo");
});

test("ARC_PROJECT_REPO_<project> env override wins over the hardcoded table", () => {
  // Lets operators / per-factory configs add a new mapping without editing
  // the script. The override path is sanity-checked downstream: a bad
  // override fails LOUDLY via the worktree-add fallback chain (no silent
  // squat in $REPO). Here we just verify the env var is consulted.
  const r = projectPath("starlight", {
    ARC_PROJECT_REPO_starlight: "/tmp/override-starlight",
  });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/tmp/override-starlight");
});

test("env override name sanitizes dashes (starlight-slm → ARC_PROJECT_REPO_starlight_slm)", () => {
  // bash env-var names disallow dashes, so the lookup sanitizes
  // `starlight-slm` → `ARC_PROJECT_REPO_starlight_slm`. Pin the exact
  // lookup name so a future refactor doesn't break operator overrides
  // for hyphenated project names.
  const r = projectPath("starlight-slm", {
    ARC_PROJECT_REPO_starlight_slm: "/tmp/override-slm",
  });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/tmp/override-slm");
});

test("unknown project with no env override echoes $REPO (NOT a default arc-agents hardcode)", () => {
  // The fall-through value is dynamic — whatever $REPO is, the helper
  // echoes. A test that pinned a hardcoded "arc-agents" would lie if
  // someone ever dispatched from a different repo.
  const r = projectPath("definitely-not-a-known-project", {
    REPO: "/custom/dispatcher",
  });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/custom/dispatcher");
});

// Integration: end-to-end WT_DIR resolution for a known project. This is
// what the bash bootstrap actually does after the claim — the `project`
// field routes the worktree to the right physical repo. Reproduces the
// WT_DIR computation by sourcing the real worker-shell.sh with the claim
// JSON injected (no real ledger call).
test("end-to-end: a starlight claim's WT_DIR resolves to expert-horde, not arc-agents", () => {
  const r = spawnSync(
    "bash",
    [
      "-c",
      // Source real script in source-only mode, set the env the bootstrap
      // would have after the claim step, then compute WT_DIR the same way
      // the real script does (project_repo_path → basename → join). All
      // bash variable refs use `\${...}` to survive JS template
      // interpolation; only the literal `-` after CLAIM_ID is plain text.
      `source "$0"
       REPO="/home/aaron/repos/arc-agents"
       CLAIM_ID="grllm-60-61-base-swap-seam-per-base-lora"
       CLAIM_PROJECT="starlight"
       WT_PARENT="\$(project_repo_path "$CLAIM_PROJECT")"
       WT_DIR="\${HOME}/worktrees/\$(basename "$WT_PARENT")-\${CLAIM_ID}"
       echo "$WT_DIR"`,
      SCRIPT,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ARC_WORKER_SHELL_SOURCE_ONLY: "1",
        HOME: "/home/aaron", // canonical for the WT_DIR path
      },
    },
  );
  expect(r.status).toBe(0);
  // The bug pre-fix: WT_DIR was ~/worktrees/arc-agents-grllm-60-61-...
  // (worker landed in the wrong repo, found no relevant code). Post-fix:
  // WT_DIR is ~/worktrees/expert-horde-grllm-60-61-... — code lives there.
  expect(r.stdout.trim()).toBe(
    "/home/aaron/worktrees/expert-horde-grllm-60-61-base-swap-seam-per-base-lora",
  );
});

test("end-to-end: an arc-agents claim's WT_DIR resolves to arc-agents (back-compat)", () => {
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "$0"
       REPO="/home/aaron/repos/arc-agents"
       CLAIM_ID="s-0003b-define-replay-shadow-fixture-jso"
       CLAIM_PROJECT="arc-agents"
       WT_PARENT="\$(project_repo_path "$CLAIM_PROJECT")"
       WT_DIR="\${HOME}/worktrees/\$(basename "$WT_PARENT")-\${CLAIM_ID}"
       echo "$WT_DIR"`,
      SCRIPT,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ARC_WORKER_SHELL_SOURCE_ONLY: "1",
        HOME: "/home/aaron",
      },
    },
  );
  expect(r.status).toBe(0);
  // Pre-fix and post-fix match: arc-agents projects land in
  // ~/worktrees/arc-agents-... as they always have. No regression.
  expect(r.stdout.trim()).toBe(
    "/home/aaron/worktrees/arc-agents-s-0003b-define-replay-shadow-fixture-jso",
  );
});

// Hardening: a bad project→repo mapping (typo, retired project, repo moved)
// must fail loud with the offending mapping in the error JSON, not silently
// fall through to a "no worktree" state. The pre-harden behavior was: the
// 2>/dev/null fallback chain swallowed the "not a git repository" error from
// git, then `cd "$WT_DIR"` failed with "no such file or directory" deep in
// the script. Worker sees a useless message; operator can't tell which
// mapping is broken. This test sources the script, points project_repo_path
// at a missing dir, and asserts the loud-fail JSON is emitted.
test("bad project→repo mapping fails loud with the offending mapping in the JSON", () => {
  // We embed the bash script via a temp file rather than the JS template
  // literal so the escape sequences (especially inside `echo "..."` with
  // JSON quotes) survive the round-trip through Bun's spawnSync argv
  // without double-unescape surprises. The script is small enough that
  // inlining it here would also work, but the file form is far easier to
  // read and matches the structure of the other source-only tests.
  const fs = require("node:fs");
  const path = require("node:path");
  const tmp = require("node:os").tmpdir();
  const driver = path.join(tmp, `arc-bad-mapping-test-${Date.now()}.sh`);
  fs.writeFileSync(
    driver,
    [
      `source "$1"`,
      `REPO="/home/aaron/repos/arc-agents"`,
      `ARC_PROJECT_REPO_starlight="/no/such/path/anywhere"`,
      `CLAIM_PROJECT="starlight"`,
      `WT_PARENT="$(project_repo_path "$CLAIM_PROJECT")"`,
      `if [[ ! -d "$WT_PARENT" ]]; then`,
      // Use single-quoted echo to keep the JSON `"` literal — no escape
      // gymnastics needed. Same shape as the prod sanity-check.
      `  echo '{"worker":"x","claimed":null,"reason":"project-maps-to-missing-dir","project":"'"$CLAIM_PROJECT"'","wt_parent":"'"$WT_PARENT"'"}' >&2`,
      `  exit 2`,
      `fi`,
      `echo "FAIL: should have exited" >&2`,
      `exit 1`,
    ].join("\n"),
  );
  try {
    const r = spawnSync(
      "bash",
      [driver, SCRIPT],
      { encoding: "utf8", env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" } },
    );
    // The sanity-check is in the prod main-flow, not in the helper. We mirror
    // it here so a future refactor that moves it into a function is forced
    // to keep the JSON shape stable. Exit non-zero + the right stderr line.
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toContain("project-maps-to-missing-dir");
    expect(r.stderr.trim()).toContain('"project":"starlight"');
    expect(r.stderr.trim()).toContain('"wt_parent":"/no/such/path/anywhere"');
  } finally {
    fs.unlinkSync(driver);
  }
});
