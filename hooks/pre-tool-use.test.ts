// Smoke: PreToolUse hook blocks destructive ops and references only resolvable paths.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO, "hooks", "pre-tool-use.sh");

function runHook(tool: string, payload: string) {
  const r = spawnSync("bash", [HOOK, tool, payload], { encoding: "utf8" });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

test("blocks rm -rf", () => {
  const r = runHook("Bash", "rm -rf /tmp/foo");
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/HOOK_BLOCKED/);
});

test("blocks git push --force", () => {
  const r = runHook("Bash", "git push --force origin main");
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/HOOK_BLOCKED/);
});

test("allows benign Bash", () => {
  const r = runHook("Bash", "ls -la");
  expect(r.status).toBe(0);
});

test("hook message references only paths that resolve on disk", () => {
  // Extract any path-shaped tokens from the hook source's echo messages.
  // A referenced script (e.g. ~/foo/bar.ts) must exist; pure templated trash
  // dirs (~/trash/$(date ...)) are skipped because they're constructed at use.
  const src = readFileSync(HOOK, "utf8");
  const echoes = [...src.matchAll(/echo\s+"([^"]+)"/g)].map(m => m[1]);
  const tokenRe = /(~\/[A-Za-z0-9._\-\/]+|\.\/[A-Za-z0-9._\-\/]+|\/[A-Za-z0-9._\-\/]+)/g;
  const referenced: string[] = [];
  for (const msg of echoes) {
    for (const tok of msg.matchAll(tokenRe)) referenced.push(tok[1]);
  }
  for (const ref of referenced) {
    if (ref.includes("$")) continue; // shell-expanded placeholder
    const abs = ref.startsWith("~/") ? join(homedir(), ref.slice(2)) : resolve(ref);
    // Only assert resolution for script-like refs (have an extension or end in .ts/.sh).
    if (/\.(ts|sh|js|py)$/.test(abs)) {
      expect(existsSync(abs)).toBe(true);
    }
  }
});
