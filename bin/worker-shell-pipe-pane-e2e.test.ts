// E2E: real-time pane capture via `tmux pipe-pane` actually populates the
// per-worker logfile with the worker's rendered output.
//
// PR #247 added `capture_scrollback_to_log` as a script-exit fallback, but
// for interactive workers (which `exec` claude) the fallback never runs, and
// for fast-completing hygiene claims the factory SIGKILLs the tmux session
// before the script reaches the fallback. The fix attaches `tmux pipe-pane`
// to the worker's pane BEFORE the exec/headless-child runs; the pipe lives
// on the PANE, so it survives both the exec and the SIGKILL, and the `-o`
// flag closes it (flushing the buffer) when the pane exits.
//
// This is a focused integration test of `setup_pipe_pane` against a real
// tmux server (not a full worker lifecycle — that requires a real LLM API
// call and a factory, both of which are tested in factory.test.ts). We:
//   1. Source the real worker-shell.sh (same loader the unit tests use)
//   2. Spawn a real tmux session
//   3. Call `setup_pipe_pane "$sess" "$log"`
//   4. Send some text into the session via `send-keys` (simulating a TUI
//      render or `pi -p` stdout flush — both go through the same pipe)
//   5. Kill the session; the `-o` flag should flush the pipe to disk
//   6. Assert the logfile contains the sent text
//
// We can't easily start an interactive `claude` here (it'd need an LLM
// credential), but pipe-pane is content-agnostic: the same pipe that
// captures "claude rendered X to /dev/tty" also captures "sh printed X to
// stdout" once the rendered bytes hit the pane's PTY.

import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SHELL = join(REPO, "bin", "worker-shell.sh");

let workDir: string;
const createdSessions: string[] = [];

function tmux(args: string[]) {
  return spawnSync("tmux", args, { encoding: "utf8" });
}

afterEach(() => {
  for (const s of createdSessions) tmux(["kill-session", "-t", s]);
  createdSessions.length = 0;
  rmSync(workDir, { recursive: true, force: true });
});

// Source worker-shell.sh in source-only mode and call setup_pipe_pane on
// the given (real) tmux session. Returns the trimmed stdout (none) + rc.
function attachPipe(sess: string, log: string): { rc: number } {
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && setup_pipe_pane "$1" "$2"`, SHELL, sess, log],
    { encoding: "utf8", env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" } },
  );
  return { rc: r.status ?? -1 };
}

test("setup_pipe_pane actually writes pane content to the logfile", () => {
  workDir = mkdtempSync(join(tmpdir(), "arc-pipe-pane-e2e-"));
  const sess = `arctest-pp-${Math.random().toString(36).slice(2, 6)}`;
  const log = join(workDir, `${sess}.log`);
  createdSessions.push(sess);

  // Spawn a real tmux session. `cat` keeps the pane alive and echoes
  // whatever stdin sends; perfect for verifying the pipe captures
  // rendered content (which is how a TUI agent's output reaches the
  // pane: bytes → PTY → pane → pipe-pane reader → logfile).
  const r = tmux(["new-session", "-d", "-s", sess, "cat"]);
  expect(r.status).toBe(0);

  // Wire up the pipe (the actual production call site, no shortcuts).
  const a = attachPipe(sess, log);
  expect(a.rc).toBe(0);

  // Push 2 KB of distinguishable content into the pane. `cat` echoes
  // it back to the pane, which is exactly what would happen for an
  // agent whose `claude` / `pi` output flowed through the PTY.
  const marker = `PIPE_PANE_E2E_MARKER_${sess}`;
  const payload = Array.from({ length: 25 }, (_, i) => `${marker} line=${i + 1}`).join("\n");
  tmux(["send-keys", "-t", sess, payload, "Enter"]);

  // Give pipe-pane a moment to drain to disk. (The default flush
  // interval is small but not zero; 500ms is generous for a 2 KB blob.)
  Bun.sleepSync(500);

  // Kill the session — the `-o` flag on pipe-pane closes the pipe on
  // pane exit, flushing any buffered content.
  tmux(["kill-session", "-t", sess]);
  // Mark it cleaned so afterEach doesn't try again.
  const idx = createdSessions.indexOf(sess);
  if (idx >= 0) createdSessions.splice(idx, 1);

  // Assertion 1: logfile exists and is >1 KB (acceptance criterion from
  // the task body: "stat -c %s should return >1000, currently returns 85").
  expect(existsSync(log)).toBe(true);
  const size = statSync(log).size;
  expect(size).toBeGreaterThan(1000);

  // Assertion 2: all 25 marker lines made it through, in order (the
  // strict version — proves pipe-pane is the source, not a side
  // channel). Cat on a single pane doesn't reorder, but tmux's
  // internal buffer is observable; if the pipe ever dropped a line
  // the order check would fail.
  const content = readFileSync(log, "utf8");
  let cursor = 0;
  for (let i = 1; i <= 25; i++) {
    const line = `${marker} line=${i}`;
    const foundAt = content.indexOf(line, cursor);
    expect(foundAt).toBeGreaterThanOrEqual(0);
    cursor = foundAt + line.length;
  }
});

test("setup_pipe_pane works on a session that runs a printing command (headless-pi analog)", () => {
  // Closer analog to the production path: a one-shot command that writes
  // to stdout, then exits (headless `pi -p` does exactly this). The pipe
  // must capture the bytes before the pane dies.
  workDir = mkdtempSync(join(tmpdir(), "arc-pipe-pane-e2e-"));
  const sess = `arctest-pp-${Math.random().toString(36).slice(2, 6)}`;
  const log = join(workDir, `${sess}.log`);
  createdSessions.push(sess);

  // 2 KB payload via printf in a shell that first WAITS for the pipe to
  // be attached (a real worker-shell would have already attached the
  // pipe by the time the agent starts; we approximate that with a
  // sentinel file the test creates BEFORE the shell prints). Once the
  // shell sees the sentinel it flushes the payload and exits. This
  // eliminates the race where the shell finishes before attachPipe
  // returns.
  const marker = `HEADLESS_PRINT_MARKER_${sess}`;
  const payload = Array.from({ length: 30 }, (_, i) => `${marker} i=${i + 1}`).join(" ");
  const readySentinel = join(workDir, "ready");
  tmux([
    "new-session", "-d", "-s", sess, "sh", "-c",
    // wait for the sentinel (the test creates it after attachPipe), then print + exit
    `for i in 1 2 3 4 5 6 7 8 9 10; do [ -f '${readySentinel}' ] && break; sleep 0.1; done; printf '%s\\n' '${payload}'; sleep 0.1; exit 0`,
  ]);

  // Wire pipe-pane.
  const a = attachPipe(sess, log);
  expect(a.rc).toBe(0);
  // Release the shell to print.
  writeFileSync(readySentinel, "");

  // Wait for the session to die on its own (printf → exit).
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ls = tmux(["list-sessions", "-F", "#{session_name}"]);
    if (ls.status !== 0 || !ls.stdout.split("\n").includes(sess)) break;
    Bun.sleepSync(50);
  }
  const idx = createdSessions.indexOf(sess);
  if (idx >= 0) createdSessions.splice(idx, 1);

  expect(existsSync(log)).toBe(true);
  const size = statSync(log).size;
  expect(size).toBeGreaterThan(1000);
  const content = readFileSync(log, "utf8");
  expect(content).toContain(marker);
});

// Ordering regression guard (the defect PR #252 shipped): the pipe attach must
// come BEFORE the interactive `exec`, not inside the loop's headless branch.
// `exec` replaces this script with claude and never returns, so an attach below
// it is unreachable on the interactive path — which is the path that HAS the
// 85-byte bug (M-0002: workers are interactive `claude`, no `-p`). Booting the
// real script end-to-end would need a live ledger claim, a worktree and a
// `claude` binary; the source order is the property that actually broke, so
// that is what this pins.
// ponytail: static order check, not a full boot — upgrade to a real boot
// harness if worker-shell grows a second exec path.
test("pipe attach precedes the interactive exec in worker-shell.sh", () => {
  const src = readFileSync(SHELL, "utf8").split("\n");
  const attach = src.findIndex((l) => /^\s*setup_pipe_pane "\$WORKER" "\$LOG_FILE"/.test(l));
  const exec = src.findIndex((l) => /^\s*exec "\$\{CMD_PARTS\[@\]\}"/.test(l));

  expect(attach).toBeGreaterThan(-1);
  expect(exec).toBeGreaterThan(-1);
  expect(attach).toBeLessThan(exec);
});
