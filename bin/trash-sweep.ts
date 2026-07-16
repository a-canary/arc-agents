#!/usr/bin/env bun
// trash-sweep — prune files in ~/trash/ whose .ttl marker is past sweep_after.
//
// Contract: see skills/trash-retired-files/SKILL.md (the .ttl schema).
// A file parked by trash-retired-files lives at:
//   $TRASH_DIR/<unix-ts>_<name>-<YYYYMMDD>/<basename>
// alongside a sidecar:
//   $TRASH_DIR/<unix-ts>_<name>-<YYYYMMDD>/<basename>.ttl
// The .ttl contains a `sweep_after: YYYYMMDD` line. Once today > sweep_after,
// the sweep deletes the file and its .ttl sidecar. The enclosing dir is
// removed when empty.
//
// Reversibility window: until sweep_after has passed, the file is on disk and
// recoverable with `git show <origin_sha>:<origin_path>` (origin_sha is in the
// .ttl). After sweep, the file is gone and recovery requires the originating
// commit to still be reachable in the source repo.
//
// Usage:
//   bun bin/trash-sweep.ts                    # dry run: print plan
//   bun bin/trash-sweep.ts --apply            # actually delete
//   bun bin/trash-sweep.ts --dir <path>       # override $TRASH_DIR
//
// Output: JSON to stdout, regardless of TTY. Exit 0 on success (including
// nothing-to-sweep). Exit 2 on usage error.

import { readdirSync, readFileSync, statSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}

function die(msg: string): never {
  process.stderr.write(`trash-sweep: ${msg}\n`);
  process.exit(2);
}

const apply = args.includes("--apply");
const trashDir = getFlag("dir") ?? process.env.TRASH_DIR ?? join(homedir(), "trash");

if (!existsSync(trashDir)) {
  const empty = {
    trash_dir: trashDir,
    applied: apply,
    today: new Date().toISOString().slice(0, 10),
    swept_count: 0,
    kept_count: 0,
    error_count: 0,
    swept: [],
    kept: [],
    errors: [],
    error: `trash dir not found: ${trashDir}`,
  };
  process.stdout.write(JSON.stringify(empty) + "\n");
  process.exit(0);
}

// Parse a .ttl sidecar. Format is line-oriented `key: value`.
// Returns the parsed fields, or null if the file is malformed.
type TtlMarker = {
  retired_at: string;
  retired_by: string;
  origin_path: string;
  origin_repo: string;
  origin_sha: string;
  ledger_row: string;
  sweep_after: string; // YYYYMMDD
  reason: string;
};

function parseTtl(content: string): TtlMarker | null {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  const required = ["sweep_after", "origin_path", "origin_repo", "origin_sha"];
  for (const k of required) {
    if (!out[k]) return null;
  }
  return out as unknown as TtlMarker;
}

function isPast(sweepAfter: string, today: Date): boolean {
  // sweep_after is YYYYMMDD (UTC per the SKILL contract).
  if (!/^\d{8}$/.test(sweepAfter)) return false;
  const y = Number(sweepAfter.slice(0, 4));
  const mo = Number(sweepAfter.slice(4, 6)) - 1;
  const d = Number(sweepAfter.slice(6, 8));
  const cutoff = Date.UTC(y, mo, d, 23, 59, 59); // inclusive through end of day
  return today.getTime() > cutoff;
}

type Entry =
  | { kind: "swept"; path: string; sweep_after: string; origin_path: string; origin_repo: string; origin_sha: string }
  | { kind: "kept"; path: string; sweep_after: string; reason: string }
  | { kind: "kept"; path: string; reason: string } // .ttl malformed / missing
  | { kind: "error"; path: string; reason: string };

const swept: Entry[] = [];
const kept: Entry[] = [];
const errors: Entry[] = [];

const today = new Date();
const topEntries = readdirSync(trashDir, { withFileTypes: true });

for (const entry of topEntries) {
  // Top-level entries are either pre-TTL loose files (legacy, ignore) or
  // <unix-ts>_<name>-<YYYYMMDD>/ dirs containing the moved files + their .ttl
  // sidecars. We only process the dated dirs.
  if (!entry.isDirectory()) continue;
  if (!/^\d+_.+-\d{8}$/.test(entry.name)) continue;
  const batchDir = join(trashDir, entry.name);
  const files = readdirSync(batchDir, { withFileTypes: true });
  for (const f of files) {
    if (f.isDirectory()) continue; // nested — leave alone
    if (f.name.endsWith(".ttl")) continue; // sidecar, handled with its base file
    const filePath = join(batchDir, f.name);
    const ttlPath = filePath + ".ttl";
    if (!existsSync(ttlPath)) {
      kept.push({ kind: "kept", path: filePath, reason: "no .ttl sidecar" });
      continue;
    }
    const ttlContent = readFileSync(ttlPath, "utf8");
    const marker = parseTtl(ttlContent);
    if (!marker) {
      kept.push({ kind: "kept", path: filePath, reason: "malformed .ttl" });
      continue;
    }
    if (!isPast(marker.sweep_after, today)) {
      kept.push({
        kind: "kept",
        path: filePath,
        sweep_after: marker.sweep_after,
        reason: "sweep_after not yet reached",
      });
      continue;
    }
    if (apply) {
      try {
        unlinkSync(filePath);
        unlinkSync(ttlPath);
        swept.push({
          kind: "swept",
          path: filePath,
          sweep_after: marker.sweep_after,
          origin_path: marker.origin_path,
          origin_repo: marker.origin_repo,
          origin_sha: marker.origin_sha,
        });
      } catch (e) {
        errors.push({ kind: "error", path: filePath, reason: String(e) });
      }
    } else {
      swept.push({
        kind: "swept",
        path: filePath,
        sweep_after: marker.sweep_after,
        origin_path: marker.origin_path,
        origin_repo: marker.origin_repo,
        origin_sha: marker.origin_sha,
      });
    }
  }
  // If the batch dir is now empty, remove it (best-effort).
  if (apply) {
    try {
      const remaining = readdirSync(batchDir);
      if (remaining.length === 0) rmdirSync(batchDir);
    } catch {
      // non-fatal — sweep succeeded on the files we cared about
    }
  }
}

const summary = {
  trash_dir: trashDir,
  applied: apply,
  today: today.toISOString().slice(0, 10),
  swept_count: swept.length,
  kept_count: kept.length,
  error_count: errors.length,
  swept,
  kept,
  errors,
};

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

if (errors.length > 0) process.exit(1);
process.exit(0);

// Suppress unused-import warning for dirname (kept for future batch-path ops).
void dirname;
