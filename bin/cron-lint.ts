#!/usr/bin/env bun
// cron-lint — fail on crontab entries that need bun/pi on PATH but have no
// PATH pin (per-entry `PATH=...` prefix or a global `PATH=` env line).
//
// F6: raw crontab is the only schedule registry and PATH pinning is
// inconsistent. This lint makes the inconsistency visible/failing.
//
// Usage:  cron-lint.ts [file]      (default: stdin)
// Exit:   0 clean, 1 violations found, 2 usage error
//
import { readFileSync } from "node:fs";

// ponytail: needs-pin detection is a string heuristic (bun/pi invocation or
// .ts reference). A plain .sh entry that internally needs bun is NOT caught;
// upgrade path = explicit `# cron-req: bun` annotation on the entry.

export interface Violation {
  line: number; // 1-based
  command: string;
}

// Invocation of the bun or pi binary, or a reference to a .ts script.
// Absolute paths count (`.bun/bin/bun`): .ts scripts spawn children that
// resolve via PATH, so the pin is wanted even when the binary itself is
// absolute. Word-boundary classes keep `pip`, `pipe`, `.bun/` in a PATH
// value from matching.
const NEEDS_PIN =
  /(^|[\s"'=(\/])bun([\s;|&)]|$)|(^|[\s"'=(\/])pi([\s;|&)]|$)|\.tsx?([\s"'`;|&) ]|$)/;

const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;
const ENTRY_HEAD = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+/; // 5 time fields + command start

export function lintCrontab(text: string): Violation[] {
  const out: Violation[] = [];
  let globalPath = false;
  for (const [idx, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (ENTRY_HEAD.test(line)) {
      // Strip per-entry env assignments after the 5 time fields.
      const rest = line.replace(/^\S+(?:\s+\S+){4}\s*/, "");
      let command = rest;
      let pinned = globalPath;
      for (;;) {
        const m = command.match(/^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/);
        if (!m) break;
        if (m[1] === "PATH") pinned = true;
        command = command.slice(m[0].length);
      }
      if (NEEDS_PIN.test(command) && !pinned) {
        out.push({ line: idx + 1, command });
      }
    } else if (ENV_LINE.test(line)) {
      if (/^PATH\s*=/.test(line)) globalPath = true;
    }
    // anything else: not an entry we can judge — skip
  }
  return out;
}

// --- CLI ---
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log("usage: cron-lint.ts [file]   (default: stdin)");
    process.exit(0);
  }
  let text: string;
  if (args.length === 1 && !args[0]!.startsWith("-")) {
    try {
      text = readFileSync(args[0]!, "utf8");
    } catch {
      process.stderr.write(`cron-lint: cannot read ${args[0]}\n`);
      process.exit(2);
    }
  } else if (args.length === 0) {
    text = readFileSync(0, "utf8"); // fd 0 = stdin
  } else {
    process.stderr.write("cron-lint: expected at most one file argument\n");
    process.exit(2);
  }
  const violations = lintCrontab(text);
  for (const v of violations) {
    console.log(`line ${v.line}: unpinned PATH for bun/pi entry: ${v.command}`);
  }
  process.exit(violations.length ? 1 : 0);
}
