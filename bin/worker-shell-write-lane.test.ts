// worker-shell.sh ensure_write_lane_hook — factory-level install of the
// write-lane PreToolUse hook (arc-director DESIGN.md invariant 7).
//
// Drives the REAL script's helper via ARC_WORKER_SHELL_SOURCE_ONLY=1 (same
// pattern as worker-shell-repo.test.ts for resolve_repo) against a fake HOME,
// so production ~/.claude/settings.json is never touched by tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "worker-shell.sh");
const MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash";

function hookCmd(home: string): string {
  return join(home, "repos", "arc-director", "hooks", "pre-write-lane.sh");
}

// Fake HOME with a stub pre-write-lane.sh so the [ -f "$hook_cmd" ] guard passes.
function mkHome(): string {
  const home = mkdtempSync(join(tmpdir(), "write-lane-home-"));
  mkdirSync(join(home, "repos", "arc-director", "hooks"), { recursive: true });
  writeFileSync(join(home, "repos", "arc-director", "hooks", "pre-write-lane.sh"), "#!/usr/bin/env bash\n");
  return home;
}

function callEnsure(home: string, settings?: string): { rc: number; stderr: string } {
  const env: Record<string, string> = { HOME: home, ARC_DIRECTOR: join(home, "repos", "arc-director") };
  if (settings) env.CLAUDE_SETTINGS_JSON = settings;
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && ensure_write_lane_hook`, SCRIPT],
    { encoding: "utf8", env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1", ...env } },
  );
  return { rc: r.status ?? -1, stderr: r.stderr };
}

function readSettings(home: string): any {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
}

describe("ensure_write_lane_hook", () => {
  test("creates settings.json with the PreToolUse entry when absent", () => {
    const home = mkHome();
    expect(callEnsure(home).rc).toBe(0);
    const s = readSettings(home);
    const entries = s.hooks.PreToolUse.filter((e: any) => e.matcher === MATCHER);
    expect(entries.length).toBe(1);
    expect(entries[0].hooks.map((h: any) => h.command)).toEqual([hookCmd(home)]);
  });

  test("is idempotent — second run adds no duplicate entry or command", () => {
    const home = mkHome();
    callEnsure(home);
    callEnsure(home);
    const s = readSettings(home);
    const entries = s.hooks.PreToolUse.filter((e: any) => e.matcher === MATCHER);
    expect(entries.length).toBe(1);
    expect(entries[0].hooks.length).toBe(1);
  });

  test("preserves existing unrelated hooks and appends to an existing matching entry", () => {
    const home = mkHome();
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/existing/guard.sh" }] },
          { matcher: MATCHER, hooks: [{ type: "command", command: "/per-repo/pre-write-lane.sh" }] },
        ],
      },
    }));
    expect(callEnsure(home).rc).toBe(0);
    const s = readSettings(home);
    // Unrelated entry untouched.
    expect(s.hooks.PreToolUse.find((e: any) => e.matcher === "Bash").hooks[0].command).toBe("/existing/guard.sh");
    // Matching entry keeps its per-repo command and gains the factory one, once.
    const m = s.hooks.PreToolUse.filter((e: any) => e.matcher === MATCHER);
    expect(m.length).toBe(1);
    expect(m[0].hooks.map((h: any) => h.command)).toEqual(["/per-repo/pre-write-lane.sh", hookCmd(home)]);
  });

  test("fails open (rc 0, file untouched) on invalid JSON", () => {
    const home = mkHome();
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, "{not json");
    const r = callEnsure(home);
    expect(r.rc).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe("{not json");
    expect(r.stderr).toContain("invalid JSON");
  });

  test("fails open (rc 0, no write) when the hook script is missing", () => {
    const home = mkHome();
    rmSync(join(home, "repos", "arc-director", "hooks", "pre-write-lane.sh"));
    const r = callEnsure(home);
    expect(r.rc).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(r.stderr).toContain("not found");
  });

  test("leaves no tmp litter on the success path", () => {
    const home = mkHome();
    callEnsure(home);
    const litter = readdirSync(join(home, ".claude")).filter((f) => f.includes("lane-tmp"));
    expect(litter.length).toBe(0);
  });
});
