#!/usr/bin/env bun
// bin/wakeme — register scoped wake watches in ~/.pi/agent/wake-requests.jsonl.
// Design: hooks/pi-extension/DESIGN-wake.md. One line per watch; the pi
// extension polls the file and wakes only the session that registered it.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readProcStartTime } from "../hooks/pi-extension/wake-core";

const FILE = `${process.env.HOME}/.pi/agent/wake-requests.jsonl`;
const SESSION = process.env.PI_SESSION_ID;
const DEFAULT_STATES = "merged,failed,cancelled,blocked";

function die(msg: string): never {
  console.error(`wakeme: ${msg}`);
  process.exit(1);
}

// fail loud on write errors — a dropped watch is a silent no-op for the agent
function append(line: object): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify(line) + "\n");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    die(`cannot write ${FILE}: ${e.code ?? e.message}`);
  }
}

function flag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) return args[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

const [verb, ...rest] = process.argv.slice(2);
switch (verb) {
  case "row": {
    const id = rest[0];
    if (!SESSION || !id) die("usage: wakeme row <id> [--states a,b,c] — needs PI_SESSION_ID");
    append({
      session: SESSION, type: "row", id,
      states: (flag(rest, "states") ?? DEFAULT_STATES).split(","),
      ts: Date.now(),
    });
    break;
  }
  case "cmd": {
    const cmd = rest[0];
    const label = flag(rest, "label");
    if (!SESSION || !cmd || !label) die('usage: wakeme cmd "<cmd>" --label "<label>" [--cwd /path] — needs PI_SESSION_ID');
    append({ session: SESSION, type: "cmd", cmd, label, cwd: flag(rest, "cwd") ?? process.cwd(), ts: Date.now() });
    break;
  }
  case "pid": {
    const pid = Number(rest[0]);
    const label = flag(rest, "label");
    if (!SESSION || !Number.isInteger(pid) || pid <= 0 || !label) die("usage: wakeme pid <pid> --label \"<label>\" — needs PI_SESSION_ID");
    // capture start time at arming → PID-reuse safe (DESIGN-wake.md)
    append({ session: SESSION, type: "pid", pid, label, startTime: readProcStartTime(pid), ts: Date.now() });
    break;
  }
  case "list": {
    let content = "";
    try {
      content = readFileSync(FILE, "utf-8");
    } catch {
      process.exit(0);
    }
    for (const line of content.split("\n")) if (line.trim()) console.log(line);
    break;
  }
  case "gc": {
    const cutoff = Date.now() - 7 * 86_400_000;
    let content = "";
    try {
      content = readFileSync(FILE, "utf-8");
    } catch {
      console.log("gc: nothing to do (no request file)");
      process.exit(0);
    }
    let kept = 0, dropped = 0, corrupt = 0;
    const lines: string[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line) as { ts?: unknown };
        if (typeof req.ts === "number" && req.ts < cutoff) dropped++;
        else { lines.push(line); kept++; }
      } catch {
        corrupt++; // corrupt lines are dropped here, counted in output
      }
    }
    writeFileSync(FILE, lines.join("\n") + (lines.length ? "\n" : ""));
    console.log(`gc: kept ${kept}, dropped ${dropped} (>7d), corrupt ${corrupt}`);
    break;
  }
  default:
    die('usage: wakeme row <id> [--states a,b] | cmd "<cmd>" --label L [--cwd P] | pid <pid> --label L | list | gc');
}
