// Root cause of engine-alias-no-work:minimax-build (and other cli-agent-backed
// aliases): a `cli-agent` candidate run without `--cwd` uses cli-proxy's
// stateless pool, whose cwd is pinned to an empty sandbox — tools run but see
// no repo, so every worker "produces no work" and the alias's whole failover
// chain exhausts. `--cwd "$WT_DIR"` roots cli-agent in the worker's own
// worktree. See improve-architecture-investigate-minimax.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh"),
  "utf8",
);

test("cli-agent candidate branch injects --cwd \"$WT_DIR\"", () => {
  const marker = 'CMD_PARTS[0]:-}" == "cli-agent"';
  const idx = SCRIPT.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const branch = SCRIPT.slice(idx, SCRIPT.indexOf("else", idx));
  expect(branch).toContain('CMD_PARTS+=( --cwd "$WT_DIR" )');
});
