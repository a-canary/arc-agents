/**
 * run_ea.sh round-7 failures — regression test.
 *
 * Bug 1: mkdir -p for round-N dir came AFTER the redirect to
 *   round-${rnd}/specs_raw.json, so the write always failed with
 *   "No such file or directory" (the dir didn't exist yet).
 *   Fix: mkdir -p before the write (moved from line ~38 to ~27).
 *
 * Bug 2: python3 << 'PYEOF' (quoted heredoc) prevents $rnd expansion,
 *   so Python saw literal "$rnd" instead of the round number, causing
 *   "SyntaxError: invalid syntax" on `rnd = $rnd`.
 *   Fix: python3 << PYEOF (unquoted heredoc, bash expands $rnd first).
 *
 * Bug 3: json.dumps(spec) inside an f-string prompt corrupted \n/\t
 *   literal characters in JSON, mangling the LLM prompt. repr() escapes them.
 *   Fix: Spec: {repr(json.dumps(spec))}.
 *
 * These bugs caused round-7 (and all rounds 1-10) to fail with empty specs
 * and SyntaxError in the original run (ea_run_20260506_032959.log).
 *
 * Verification: bash -n run_ea.sh passes; round-07 has 10 real specs
 *   in webui-specs/rounds/round-07/specs.json.
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";

const script = readFileSync("/home/aaron/webui-specs/run_ea.sh", "utf8");
const lines = script.split("\n");

describe("run_ea.sh round-7 fixes", () => {
  it("webui-specs run_ea.sh passes bash -n syntax check", () => {
    const result = Bun.spawnSync({
      cmd: ["bash", "-n", "/home/aaron/webui-specs/run_ea.sh"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  });

  it("mkdir comes before redirect to specs_raw.json (line ordering)", () => {
    let mkdirLine = -1;
    let redirectLine = -1;
    let inForLoop = false;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim().startsWith("for rnd in")) inForLoop = true;
      if (inForLoop && mkdirLine === -1 && l.includes("mkdir -p") && l.includes("$ROUNDS")) {
        mkdirLine = i;
      }
      if (inForLoop && redirectLine === -1 && l.includes("specs_raw.json") && l.includes(">")) {
        redirectLine = i;
      }
    }

    expect(mkdirLine).toBeGreaterThan(-1);
    expect(redirectLine).toBeGreaterThan(-1);
    expect(mkdirLine).toBeLessThan(redirectLine);
  });

  it("rating python heredoc uses unquoted << PYEOF (not quoted)", () => {
    let pyheredocLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("python3") && lines[i].includes("<<") && lines[i].includes("PYEOF")) {
        pyheredocLine = i;
        break;
      }
    }
    expect(pyheredocLine).toBeGreaterThan(-1);
    const heredocLine = lines[pyheredocLine];
    expect(heredocLine).not.toContain("<< 'PYEOF'");
    expect(heredocLine).not.toContain('<< "PYEOF"');
  });

  it("round-07 has real specs (not all-fallback r7-sN error entries)", () => {
    const specs: any[] = JSON.parse(readFileSync("/home/aaron/webui-specs/rounds/round-07/specs.json", "utf8"));
    expect(specs.length).toBeGreaterThan(0);
    const isAllFallback = specs.every(s => s.name?.startsWith("r7-s") && Boolean(s.error));
    expect(isAllFallback).toBe(false);
  });

  it("repr(json.dumps(spec)) used for f-string safety in rating prompt", () => {
    expect(script).toContain("repr(json.dumps(spec))");
  });
});