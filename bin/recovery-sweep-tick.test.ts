// Smoke test for bin/recovery-sweep-tick.sh.
//
// Two behaviors pinned:
//   1. Forward-reference no-op: when bin/recovery-sweep.ts is missing, the
//      tick exits 0 silently (avoids log-flap before the sweep MVP slice lands).
//   2. Executable invocation: the script is +x and the shebang line is valid bash.
//
// We don't run the flock path end-to-end because that requires the real sweep
// binary; the sweep MVP slice owns that test surface. Here we only pin the
// plumbing contract.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "recovery-sweep-tick.sh");

test("exits 0 when bin/recovery-sweep.ts is absent (forward-reference no-op)", () => {
  // The script checks for bin/recovery-sweep.ts relative to its own location.
  // In this checkout the sweep MVP slice hasn't landed yet, so the file
  // is expected to be missing — if this test ever fails with rc!=0, either
  // the sweep MVP has landed (and this test should be retired) or the
  // forward-reference check has regressed.
  if (existsSync(join(dirname(SCRIPT), "recovery-sweep.ts"))) {
    // Sweep MVP has landed — the forward-reference no-op path no longer
    // applies. Pass without running the script: a real sweep run does a
    // live model probe and can take minutes (unit tests must not block on it).
    return;
  }
  const r = spawnSync(SCRIPT, [], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
});

test("is executable (cron requires +x)", () => {
  const st = statSync(SCRIPT);
  // owner-execute bit (0o100)
  expect((st.mode & 0o100) !== 0).toBe(true);
});

test("uses /usr/bin/env bash shebang (matches sibling feedback-tick.sh)", () => {
  const r = spawnSync("head", ["-n", "1", SCRIPT], { encoding: "utf8" });
  expect(r.stdout.trim()).toBe("#!/usr/bin/env bash");
});
