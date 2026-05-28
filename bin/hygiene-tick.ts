#!/usr/bin/env bun
// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// hygiene-tick — round-robin hygiene cron. See plan: 6hr cron picks one repo
// from a preset list, creates a `type=cron` task that invokes a hygiene skill.
// Skip-not-stack: skips a repo that already has an OPEN hygiene cron task.
//
// Config: $ARC_HYGIENE_CONFIG (yaml) or ~/.config/arc/hygiene.yaml
//   skills: [improve-codebase-architecture, ...]
//   repos:  [ke, arc-agents, arc-webui, ...]
//
// Exit codes: 0 ok (incl. skipped:true), 2 config error

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { open, mintId } from "../src/ledger/db";

function die(code: number, msg: string): never {
  process.stderr.write(`hygiene-tick: ${msg}\n`);
  process.exit(code);
}

function configPath(): string {
  if (process.env.ARC_HYGIENE_CONFIG) return process.env.ARC_HYGIENE_CONFIG;
  return `${process.env.HOME ?? ""}/.config/arc/hygiene.yaml`;
}

const path = configPath();
if (!existsSync(path)) die(2, `config not found: ${path}`);

const cfg = parseYaml(readFileSync(path, "utf8")) ?? {};
const skills: string[] = Array.isArray(cfg.skills) ? cfg.skills : [];
const repos: string[] = Array.isArray(cfg.repos) ? cfg.repos : [];
if (skills.length === 0) die(2, "config: skills must be non-empty");
if (repos.length === 0) die(2, "config: repos must be non-empty");

const db = open();

// Open = not in a terminal state.
const TERMINAL = ["merged", "cancelled", "failed"];
const placeholders = TERMINAL.map(() => "?").join(",");

function hasOpenHygiene(repo: string): boolean {
  const row = db
    .query<{ n: number }, [string, ...string[]]>(
      `SELECT COUNT(*) AS n FROM issues
       WHERE type='cron' AND project=? AND state NOT IN (${placeholders})`,
    )
    .get(repo, ...TERMINAL);
  return (row?.n ?? 0) > 0;
}

// Round-robin: count of cron tasks for repo determines which skill to run.
function nextSkillFor(repo: string): string {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM issues WHERE type='cron' AND project=?`,
    )
    .get(repo);
  const n = row?.n ?? 0;
  return skills[n % skills.length]!;
}

// Rotation: pick the repo (a) without an open hygiene task and (b) whose last
// cron task is oldest — repos never ticked sort first (NULL last_created).
// Tie-break by config order.
function lastCreatedFor(repo: string): number | null {
  const row = db
    .query<{ ts: number | null }, [string]>(
      `SELECT MAX(created_at) AS ts FROM issues WHERE type='cron' AND project=?`,
    )
    .get(repo);
  return row?.ts ?? null;
}

let pick: { repo: string; skill: string } | null = null;
const candidates = repos
  .map((repo, idx) => ({ repo, idx, last: lastCreatedFor(repo) }))
  .filter((c) => !hasOpenHygiene(c.repo))
  .sort((a, b) => {
    if (a.last === null && b.last !== null) return -1;
    if (a.last !== null && b.last === null) return 1;
    if (a.last !== b.last) return (a.last ?? 0) - (b.last ?? 0);
    return a.idx - b.idx;
  });
if (candidates.length > 0) {
  const c = candidates[0]!;
  pick = { repo: c.repo, skill: nextSkillFor(c.repo) };
}

if (!pick) {
  process.stdout.write(JSON.stringify({ skipped: true }) + "\n");
  process.exit(0);
}

const { repo, skill } = pick;
// Sequence prefix on id ensures created_at-tied inserts still sort by creation order
// (the issues table doesn't store a rowid-style monotonic field we can query, but
// cron rotation tests rely on stable order).
const seqRow = db
  .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM issues WHERE type='cron'`)
  .get();
const seq = String((seqRow?.n ?? 0) + 1).padStart(6, "0");
const title = `hygiene: ${repo} — /${skill}`;
const body = `Run \`/${skill}\` against the \`${repo}\` repo as part of the rotating hygiene cron.\n`;
const id = `${seq}-${mintId(db, title)}`;

// Migration 017: class→tier, urgency→pool. Hygiene cron rows self-classify:
// tier='hygiene' so workers can update them via the bookie without tripping
// the tier_unset+triage_pending guard; pool='ops' matches cron scheduling slot.
db.run(
  `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
   VALUES (?, ?, ?, ?, '', 'cron', 'ready', 'task', 'hygiene', 'ops')`,
  [id, repo, title, body],
);
db.run(
  `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', 'hygiene-tick', ?)`,
  [id, title],
);

process.stdout.write(JSON.stringify({ repo, skill, id }) + "\n");