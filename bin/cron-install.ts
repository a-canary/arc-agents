#!/usr/bin/env bun
// cron-install — merge per-repo cron/ manifest files into the live crontab as
// marker blocks, idempotently. Everything outside managed blocks is untouched.
//
// F6: raw crontab is the only schedule registry; manifests live in each repo's
// cron dir (arc-agents uses bin/cron/) so entries are versioned and reviewable.
//
// Block shape (matches the hand-installed convention already in the live
// crontab, e.g. `# >>> arc-skills:nightly-self-improve >>>`):
//   # >>> <name> >>>
//   ...manifest lines...
//   # <<< <name> <<<
//
// Usage:
//   cron-install.ts install [--dry-run] [--full] [--from <file>] <manifest.cron|dir>...
// --dry-run prints per-block status + unified diff (gist); --full adds the
// entire resulting crontab.
//   cron-install.ts uninstall [--dry-run] <name>...
//
// Block name = manifest basename without extension. Two repos shipping the
// same basename collide; rename one of the manifests.
// Exit: 0 ok, 2 usage error

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export const MARKER_OPEN = (name: string) => `# >>> ${name} >>>`;
export const MARKER_CLOSE = (name: string) => `# <<< ${name} <<<`;

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function findBlock(lines: string[], name: string): [number, number] {
  const oi = lines.findIndex((l) => l.trim() === MARKER_OPEN(name));
  if (oi < 0) return [-1, -1];
  const ci = lines.findIndex((l, i) => i > oi && l.trim() === MARKER_CLOSE(name));
  if (ci < 0) throw new Error(`malformed block ${name}: missing close marker`);
  return [oi, ci];
}

/** Replace the named block in place, or append it. Foreign lines untouched. */
export function upsertBlock(current: string, name: string, body: string): string {
  const lines = toLines(current);
  const [oi, ci] = findBlock(lines, name);
  if (oi >= 0) {
    return [...lines.slice(0, oi + 1), ...body.split("\n"), ...lines.slice(ci)].join("\n");
  }
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  lines.push(MARKER_OPEN(name), ...body.split("\n"), MARKER_CLOSE(name));
  return lines.join("\n");
}

/** Remove the named block plus one trailing blank line. No-op if absent. */
export function removeBlock(current: string, name: string): string {
  const lines = toLines(current);
  const [oi, ci] = findBlock(lines, name);
  if (oi < 0) return current;
  let end = ci + 1;
  if (lines[end] === "") end++;
  return [...lines.slice(0, oi), ...lines.slice(end)].join("\n");
}

export function blockName(manifestPath: string): string {
  const base = manifestPath.split("/").pop() ?? manifestPath;
  return base.replace(/\.[^.]*$/, "");
}

/** Whether an upsert will replace an existing block or append a new one. */
export function upsertStatus(current: string, name: string): "replaced" | "appended" {
  return findBlock(toLines(current), name)[0] >= 0 ? "replaced" : "appended";
}

function expandManifests(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    const st = statSync(p);
    const files = st.isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".cron")) : [p];
    for (const f of files) {
      const full = st.isDirectory() ? `${p}/${f}` : p;
      const name = blockName(full);
      if (out.has(name)) throw new Error(`duplicate block name ${name} — rename one of the manifests`);
      out.set(name, readFileSync(full, "utf8").replace(/\n$/, ""));
    }
  }
  return out;
}

// --- CLI ---
if (import.meta.main) {
  const args = process.argv.slice(2);
  const [verb, ...rest] = args;
  const dry = rest.includes("--dry-run");
  const operands: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dry-run") continue;
    if (a === "--from") {
      i++; // skip the --from value
      continue;
    }
    operands.push(a);
  }

  if (!verb || verb === "-h" || verb === "--help" || (verb !== "install" && verb !== "uninstall")) {
    console.log("usage: cron-install.ts install [--dry-run] [--full] [--from <file>] <manifest|dir>...\n       cron-install.ts uninstall [--dry-run] <name>...");
    process.exit(2);
  }

  if (rest.includes("--from") && !rest[rest.indexOf("--from") + 1]) {
    process.stderr.write("cron-install: --from requires a file argument\n");
    process.exit(2);
  }
  // indexOf+1 with no --from present yields rest[0] (the first positional),
  // which silently became the "current crontab" file — must be explicit.
  const fromIdx = rest.indexOf("--from");
  const fromArg = fromIdx >= 0 ? rest[fromIdx + 1] : undefined;
  let current = "";
  if (verb === "install") {
    if (fromArg) {
      current = readFileSync(fromArg, "utf8");
    } else {
      const proc = Bun.spawnSync(["crontab", "-l"]);
      current = new TextDecoder().decode(proc.stdout);
      // crontab -l exits 1 with "no crontab for <user>" when empty — fine.
    }
  }

  let result: string;
  const statuses: string[] = [];
  if (verb === "install") {
    const manifests = expandManifests(operands);
    if (manifests.size === 0) {
      process.stderr.write("cron-install: no .cron manifests found\n");
      process.exit(2);
    }
    result = current;
    for (const [name, body] of manifests) {
      statuses.push(`${upsertStatus(result, name)} ${name}`);
      result = upsertBlock(result, name, body);
    }
  } else {
    if (operands.length === 0) {
      process.stderr.write("cron-install: uninstall requires block names\n");
      process.exit(2);
    }
    const proc = Bun.spawnSync(["crontab", "-l"]);
    result = new TextDecoder().decode(proc.stdout);
    for (const name of operands) result = removeBlock(result, name);
  }

  if (dry) {
    // AXI: gist first — per-block status, then unified diff, not the whole
    // crontab. --full prints the entire resulting crontab instead.
    for (const s of statuses) console.log(`cron-install: ${s}`);
    if (rest.includes("--full")) {
      process.stdout.write(result + "\n");
    } else if (toLines(result).join("\n") === toLines(current).join("\n")) {
      console.log("cron-install: no changes");
    } else {
      // ponytail: shell out to `diff -u` via temp files; untested CLI branch.
      const dir = mkdtempSync(`${tmpdir()}/cron-install-`);
      try {
        writeFileSync(`${dir}/old`, current);
        writeFileSync(`${dir}/new`, result + "\n");
        const d = Bun.spawnSync(["diff", "-u", `${dir}/old`, `${dir}/new`]);
        process.stdout.write(new TextDecoder().decode(d.stdout));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } else {
    const w = Bun.spawn(["crontab", "-"], { stdin: "pipe" });
    w.stdin.write(result + "\n");
    w.stdin.end();
    const code = await w.exited;
    if (code !== 0) {
      process.stderr.write(`cron-install: crontab - exited ${code}\n`);
      process.exit(1);
    }
    for (const s of statuses) console.log(`cron-install: ${s}`);
  }
}
