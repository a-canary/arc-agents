import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("./pre-merge.sh", import.meta.url).pathname;

function extractFn(name: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  const re = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`function ${name} not found in ${SCRIPT}`);
  return m[0];
}

function runGate(stubBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pre-merge-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "merge-gate.sh");
  writeFileSync(stub, `#!/bin/bash\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  const fnBody = extractFn("gate_merge_gate");
  const driver = `
set +e
BIN='${bin}'
PROJECT='${dir}'
pass() { echo "PASS:$1:$2"; }
fail() { echo "FAIL:$1:$2"; }
skip() { echo "SKIP:$1:$2"; }
log() { :; }
${fnBody}
gate_merge_gate
`;
  const res = spawnSync("bash", ["-c", driver], { encoding: "utf8" });
  return res.stdout + res.stderr;
}

describe("pre-merge.sh gate_merge_gate", () => {
  test("PASS when merge-gate.sh exits 0", () => {
    expect(runGate("exit 0")).toContain("PASS:merge-gate");
  });

  test("FAIL with bun install hint when typecheck shows 'tsc: command not found'", () => {
    const out = runGate("echo 'src/foo.ts: tsc: command not found' >&2; exit 1");
    expect(out).toContain("FAIL:merge-gate");
    expect(out).toContain("bun install");
  });

  test("FAIL without bun install hint for unrelated failure", () => {
    const out = runGate("echo 'real test failure' >&2; exit 1");
    expect(out).toContain("FAIL:merge-gate");
    expect(out).not.toContain("bun install");
  });
});
