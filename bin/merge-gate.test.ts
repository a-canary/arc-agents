import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, cpSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "bin/merge-gate.sh");

// Run merge-gate.sh but kill it after the install-gate line lands so the
// downstream typecheck/test gates don't recursively spin up `bun test`.
function runGateInstallOnly(project: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      // Buffer stdout line-by-line; print until install JSON appears, then exit.
      `bash '${SCRIPT}' --project '${project}' 2>&1 | awk '{print; if (/"gate":"install"/) {fflush(); exit 0}}'`,
    ],
    { encoding: "utf8", timeout: 240_000 },
  );
}

describe("merge-gate.sh gate_install", () => {
  test("fresh project without node_modules: gate_install installs deps", () => {
    const dir = mkdtempSync(join(tmpdir(), "mg-fresh-"));
    try {
      cpSync(join(REPO, "package.json"), join(dir, "package.json"));
      if (existsSync(join(REPO, "bun.lock"))) cpSync(join(REPO, "bun.lock"), join(dir, "bun.lock"));
      if (existsSync(join(REPO, "tsconfig.json"))) cpSync(join(REPO, "tsconfig.json"), join(dir, "tsconfig.json"));

      expect(existsSync(join(dir, "node_modules/.bin/tsc"))).toBe(false);
      const r = runGateInstallOnly(dir);
      expect(r.stdout).toContain('"gate":"install","status":"PASS"');
      expect(existsSync(join(dir, "node_modules/.bin/tsc"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  test("idempotent: node_modules present → gate_install SKIPs", () => {
    const dir = mkdtempSync(join(tmpdir(), "mg-idem-"));
    try {
      cpSync(join(REPO, "package.json"), join(dir, "package.json"));
      mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules/.bin/tsc"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
      const r = runGateInstallOnly(dir);
      expect(r.stdout).toContain('"gate":"install","status":"SKIP"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
