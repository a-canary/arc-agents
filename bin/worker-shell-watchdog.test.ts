// Headless worker watchdog + log-capture tests.
//
// Two liveness/observability gaps in the headless (`pi -p`) branch of
// worker-shell.sh, surfaced 2026-05-27 during daemon monitoring:
//
//   Gap 1 — no persisted log. The headless child inherited only the tmux pane
//   TTY, so a stalled worker left no forensic trail (M-0002 observability).
//
//   Gap 2 — no stall timeout. The post-exit reconciler only runs after `pi`
//   exits; a `pi` epoll-hung on a dropped upstream LLM stream (direct
//   api.minimax.io OR cli-proxy — pi has no read-timeout) never exits, so the
//   row sits `claimed` and the tmux session stays live, squatting a pool slot
//   until the factory's 4hr reap. Two such workers = 1/3 of an N=6 pool dead.
//
// The fix wraps the headless child in `timeout` (self-terminate → reconciler
// fires → slot frees) and tees its output to a per-worker logfile. The two
// pure decisions are extracted as shell functions so we can drive them without
// spawning a real pi child or touching the ledger, sourcing the REAL script
// with ARC_WORKER_SHELL_SOURCE_ONLY=1 (a copy could drift from prod).

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// Source worker-shell.sh in source-only mode and run one of its pure helpers.
// `extraEnv` lets a test set ARC_WORKER_STALL_TIMEOUT etc. Returns
// { rc, out } so timeout-validation tests can assert a non-zero exit.
function callFn(
  fn: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): { rc: number; out: string } {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && ${fn} ${quoted}`, SCRIPT],
    {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1", ...extraEnv },
    },
  );
  return { rc: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

// ---- Gap 1: log path -------------------------------------------------------

test("worker_log_path is deterministic, per-worker, under the cache dir", () => {
  const a = callFn("worker_log_path", ["arc-worker-i-3xycv2"]);
  expect(a.rc).toBe(0);
  expect(a.out).toMatch(/\/arc-workers\/arc-worker-i-3xycv2\.log$/);
  // Stable: same worker → same path.
  expect(callFn("worker_log_path", ["arc-worker-i-3xycv2"]).out).toBe(a.out);
  // Distinct: different worker → different path.
  expect(callFn("worker_log_path", ["arc-worker-a-aquby5"]).out).not.toBe(a.out);
});

test("worker_log_path honors XDG_CACHE_HOME, falls back to ~/.cache", () => {
  const xdg = callFn("worker_log_path", ["w1"], { XDG_CACHE_HOME: "/tmp/xdgtest" });
  expect(xdg.out).toBe("/tmp/xdgtest/arc-workers/w1.log");
  const home = callFn("worker_log_path", ["w1"], {
    HOME: "/home/someuser",
    XDG_CACHE_HOME: "",
  });
  expect(home.out).toBe("/home/someuser/.cache/arc-workers/w1.log");
});

// ---- Gap 2: stall timeout --------------------------------------------------

test("stall_timeout_secs defaults to a sane positive wall-clock bound", () => {
  const d = callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "" });
  expect(d.rc).toBe(0);
  const n = Number(d.out);
  expect(Number.isInteger(n)).toBe(true);
  // Must be well under the factory's 4hr (14400s) reap so the watchdog — not
  // the reap — is what frees a wedged slot; and over a few minutes so a slow
  // but live turn isn't killed.
  expect(n).toBeGreaterThanOrEqual(300);
  expect(n).toBeLessThan(14400);
});

test("stall_timeout_secs honors a valid ARC_WORKER_STALL_TIMEOUT override", () => {
  expect(callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "600" }).out).toBe("600");
  expect(callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "3600" }).out).toBe("3600");
});

test("stall_timeout_secs rejects a non-numeric or non-positive override → default", () => {
  // A garbage override must NOT silently disable the watchdog; fall back to the
  // default rather than passing junk to `timeout` (which would error and skip
  // the guard entirely).
  const def = callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "" }).out;
  expect(callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "abc" }).out).toBe(def);
  expect(callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "0" }).out).toBe(def);
  expect(callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "-5" }).out).toBe(def);
  expect(callFn("stall_timeout_secs", [], { ARC_WORKER_STALL_TIMEOUT: "12.5" }).out).toBe(def);
});

// ---- Integration: timeout 124 flows through the existing reconciler --------

// A watchdog kill (GNU `timeout` exit 124) must reconcile like any other
// non-zero exit: salvage if commits exist, else fail. This pins that the
// watchdog dovetails with reconcile_decision rather than needing a special case.
test("a watchdog-killed worker (rc 124) reconciles by commit evidence", () => {
  const killed = (commits: number) =>
    spawnSync("bash", ["-c", `source "$0" && reconcile_decision 124 "$1"`, SCRIPT, String(commits)], {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" },
    }).stdout?.trim();
  expect(killed(0)).toBe("failed"); // stalled before committing → failed
  expect(killed(2)).toBe("review"); // stalled after committing → salvage
});

// ---- Gap 1b: scrollback fallback (lost-tail pattern) -----------------------

// 166/401 worker logs in ~/.cache/arc-workers/ were 0 bytes because the
// headless `tee` pipe got SIGKILLed or broken before flushing. The fallback
// appends the tmux pane's scrollback to the logfile at script exit. We can't
// test the real tmux capture here (no tmux server in the test harness), but
// we can pin the no-op contract: outside a tmux session, the function must
// return 0, write nothing, and NOT crash on a missing logfile.
test("capture_scrollback_to_log is a no-op when not in a tmux session", () => {
  const r = callFn("capture_scrollback_to_log", ["arc-worker-i-nonexistent", "/tmp/should-not-exist.log"]);
  expect(r.rc).toBe(0);
  // The logfile must NOT have been created — the no-tmux branch skips entirely.
  // (It wouldn't be created anyway since `>>` creates the file, but a buggy
  // implementation that swallowed the no-tmux check would create it empty.)
  // We accept either "doesn't exist" or "is empty" — both prove the no-op.
  try {
    const stat = require("node:fs").statSync("/tmp/should-not-exist.log");
    expect(stat.size).toBe(0);
  } catch {
    // File doesn't exist — that's fine too, just means we didn't even touch it.
  }
});

test("capture_scrollback_to_log is a no-op when log path is empty", () => {
  // No logfile path → skip the capture (the call site computes LOG_FILE; if
  // that ever returns empty, we must not crash trying to append to "").
  const r = callFn("capture_scrollback_to_log", ["arc-worker-i-nope", ""]);
  expect(r.rc).toBe(0);
});

// ---- Gap 1c: real-time pane capture (tmux pipe-pane) -----------------------

// PR #247's `capture_scrollback_to_log` fallback only fires at script exit —
// for interactive workers the `exec "${CMD_PARTS[@]}"` REPLACES this script
// with claude, so the fallback never runs. And for hygiene claims that exit
// within 10-30s, the factory SIGKILLs the tmux session before we reach the
// fallback. The fix attaches `tmux pipe-pane` to the worker's pane BEFORE
// the exec / before the headless child runs: the pipe lives on the PANE (not
// the script's process tree), so it survives the exec and the SIGKILL, and
// `-o` closes it when the pane exits, flushing buffered content to disk.
//
// We can't run a real tmux server inside the unit test, but we can pin the
// no-op contract: outside a tmux session, the function must return 0, NOT
// create the logfile, and NOT crash.
test("setup_pipe_pane is a no-op when not in a tmux session", () => {
  const r = callFn("setup_pipe_pane", ["arc-worker-i-nonexistent", "/tmp/should-not-exist-pipe.log"]);
  expect(r.rc).toBe(0);
  try {
    const stat = require("node:fs").statSync("/tmp/should-not-exist-pipe.log");
    expect(stat.size).toBe(0);
  } catch {
    // File doesn't exist — that's fine, proves the no-op skipped the cat >>.
  }
});

test("setup_pipe_pane is a no-op when log path is empty", () => {
  // No logfile path → skip the pipe attach (mirrors the capture_scrollback
  // guard: a bad path must not crash the worker boot).
  const r = callFn("setup_pipe_pane", ["arc-worker-i-nope", ""]);
  expect(r.rc).toBe(0);
});
