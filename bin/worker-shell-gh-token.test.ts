import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHELL = join(import.meta.dir, "worker-shell.sh");

function sourceShell(env: Record<string, string>): { code: number; out: string; err: string } {
  // Note: sourcing worker-shell.sh inherits its `set -euo pipefail`, so the
  // script below must be null-safe (${GH_TOKEN:-}) like the shell itself.
  const script = `
    export ARC_WORKER_SHELL_SOURCE_ONLY=1
    unset GH_TOKEN
    ${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n")}
    source ${SHELL} >/dev/null 2>&1 || exit 97
    ensure_gh_token_on_env
    if [ -n "\${GH_TOKEN:-}" ]; then echo "GHTOK=$GH_TOKEN"; else echo "GHTOK=unset"; fi
  `;
  const r = Bun.spawnSync({ cmd: ["bash", "-c", script], stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("worker-shell.sh ensure_gh_token_on_env", () => {
  let stubDir: string;
  let emptyDir: string;
  const origPath = process.env.PATH ?? "";

  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), "gh-stub-"));
    emptyDir = mkdtempSync(join(tmpdir(), "gh-empty-"));
    writeFileSync(
      join(stubDir, "gh"),
      "#!/usr/bin/env bash\necho \"stub-gh-token\"\n",
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    process.env.PATH = origPath;
  });

  test("exports GH_TOKEN from `gh auth token` when unset", () => {
    const r = sourceShell({ PATH: `${stubDir}:${origPath}` });
    expect(r.code).toBe(0);
    expect(r.out).toContain("GHTOK=stub-gh-token");
  });

  test("preserves an already-set GH_TOKEN (does not overwrite)", () => {
    const r = sourceShell({ PATH: `${stubDir}:${origPath}`, GH_TOKEN: "preexisting" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("GHTOK=preexisting");
  });

  test("no-op when gh is missing or returns nothing", () => {
    const r = sourceShell({ PATH: emptyDir });
    expect(r.code).toBe(0);
    expect(r.out).toContain("GHTOK=unset");
  });
});
