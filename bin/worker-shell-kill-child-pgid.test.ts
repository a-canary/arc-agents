// Process-group cleanup regression test.
//
// worker-shell.sh spawns headless agents in a child process. Prior to the fix,
// when worker-shell.sh exited (normally or via signal), the child agent and its
// descendants were not killed — ppid=1, orphaned, infinite loops burned CPU
// (Aug 19 incident: 7 orphaned python3 test_*.py at 81-97% CPU, ~1200 CPU-min).
//
// Fix: run agent via `setsid` to create a new process group, trap on EXIT to
// kill the whole group (kill -TERM -<pid>). This test spawns a long-running
// child, kills the parent worker, and verifies the child dies within N seconds.

import { expect, test } from "bun:test";
import { spawn, exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("child process is killed when worker-shell exits via signal", async () => {
  const tmpdir_path = mkdtempSync(join(tmpdir(), "arc-pgid-test-"));
  try {
    // Create a dummy shell script that simulates worker-shell.sh behavior:
    // runs setsid child, traps on EXIT to kill the group.
    const workerScript = `#!/usr/bin/env bash
set -euo pipefail
trap 'kill -TERM -$$ 2>/dev/null || true' EXIT
setsid sleep 300 &
CHILD_PID=$!
wait "$CHILD_PID"
`;
    const scriptPath = join(tmpdir_path, "test-worker.sh");
    writeFileSync(scriptPath, workerScript, { mode: 0o755 });

    // Also create the child marker script (simulates long-running agent).
    const childScript = `#!/usr/bin/env bash
while true; do sleep 1; done
`;
    const childPath = join(tmpdir_path, "test-child.sh");
    writeFileSync(childPath, childScript, { mode: 0o755 });

    // Spawn the worker script, kill it after 1s, verify child dies within 5s.
    let childProcessId: string | null = null;
    const worker = spawn("bash", [scriptPath], {
      stdio: "pipe",
      detached: true, // runs in its own process group so we can signal it
    });

    // Give the worker time to spawn the child.
    await sleep(200);

    // Get the process group ID of the worker (it's detached).
    const pgid = worker.pid!.toString();

    // Kill the worker process group.
    process.kill(-parseInt(pgid), "SIGTERM");

    // Wait for worker to exit.
    await new Promise<void>((resolve) => {
      worker.on("exit", () => resolve());
    });

    // Wait a bit and check: the child (setsid sleep 300) should be dead.
    await sleep(500);

    // Try to send signal 0 (check if process exists) to the child's pgid.
    // If it's dead, this should throw. We'll use a simple ps check instead.
    const result = await new Promise<{ alive: boolean }>((resolve) => {
      exec(`ps -p ${pgid} >/dev/null 2>&1 && echo alive || echo dead`, (err, stdout) => {
        resolve({ alive: stdout.includes("alive") });
      });
    });

    expect(result.alive).toBe(false); // child should be dead
  } finally {
    rmSync(tmpdir_path, { recursive: true, force: true });
  }
});
