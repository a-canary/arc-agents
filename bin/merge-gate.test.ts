import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Resolve SCRIPT via import.meta.dir so the test is invocation-cwd-independent.
const SCRIPT = import.meta.dir + "/merge-gate.sh";

// Run the real merge-gate.sh against a throwaway git project. Gates that need
// repo tooling (typecheck/migration-lint/secret-scan) SKIP there, so `fixture`
// and `test` are what the fixtures below steer.
function runGate(opts: { testFile: boolean; failingTest?: boolean }): {
  status: number;
  out: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "merge-gate-test-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}\n");
    if (opts.testFile) {
      const body = opts.failingTest
        ? `import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(2));\n`
        : `import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n`;
      writeFileSync(join(dir, "x.test.ts"), body);
    }
    // merge-gate.sh reads git branch/HEAD; an empty repo is enough.
    spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
    const r = spawnSync("bash", [SCRIPT, "--project", dir], {
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status ?? -1, out: r.stdout ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("merge-gate.sh exit status", () => {
  test("exits 0 when Overall: PASS", () => {
    const { status, out } = runGate({ testFile: true });
    expect(out).toContain("Overall: PASS");
    expect(status).toBe(0);
  });

  test("exits non-zero when a gate FAILs (Overall: FAIL)", () => {
    // No *.test.ts at all -> gate_fixture FAILs.
    const { status, out } = runGate({ testFile: false });
    expect(out).toContain("FAIL:fixture");
    expect(out).toContain("Overall: FAIL");
    expect(status).not.toBe(0);
  });

  test("exits non-zero when the test gate FAILs", () => {
    const { status, out } = runGate({ testFile: true, failingTest: true });
    expect(out).toContain("FAIL:test");
    expect(out).toContain("Overall: FAIL");
    expect(status).not.toBe(0);
  });
});
