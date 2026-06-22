// Scorer self-check — no LLM. The --dry stub returns a correct rot13 program and
// a deliberately wrong program for everything else, so this proves extract +
// interpreter-select + case-runner + scoring end to end.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "run.ts");

function run(args: string[]) {
  return spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
}

test("dry stub: correct program scores 100%, wrong program scores 0%", () => {
  const r = run(["--dry", "--tasks", "rot13,wc-lite"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("rot13: 5/5 (100%)");
  expect(r.stdout).toContain("wc-lite: 0/6 (0%)");
});

test("MiniMax-only guard rejects a claude alias", () => {
  const r = run(["--alias", "opus-max"]); // a claude-backed alias from config.json
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("MiniMax-only");
});
