#!/usr/bin/env bun
// hygiene-tick — round-robin hygiene cron. See plan: 6hr cron picks one repo
// from a preset list, creates a `type=cron` task that invokes a hygiene skill.
// Skip-not-stack: skips a repo that already has an OPEN hygiene cron task.
//
// Config: $ARC_HYGIENE_CONFIG (yaml) or ~/.config/arc/hygiene.yaml
//   skills: [improve-codebase-architecture, ...]
//   repos:  [ke, arc-agents, arc-framework, ...]
//   cadence (optional): { <repo>: { <skill>: <days>, ... }, ... } — skip the
//     (repo, skill) combo if its last cron task fired within `days` of now.
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

// Optional per-(repo, skill) cooldown in days. When set, hygiene-tick skips
// that (repo, skill) combo if its last cron task was created within `days` of
// now. The cron still rotates through all skills in order; cooldowns just
// re-route the pick to the next eligible skill (or skip the repo entirely).
// Use this to throttle low-signal skills (e.g. `improve-architecture` and
// `trash-retired-files` against a repo in maintenance mode).
//   cadence:
//     discord-bridge:
//       improve-architecture: 30
//       trash-retired-files: 30
type CadenceMap = Record<string, Record<string, number>>;
const cadence: CadenceMap =
  cfg.cadence && typeof cfg.cadence === "object" && !Array.isArray(cfg.cadence)
    ? (cfg.cadence as CadenceMap)
    : {};

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
// With per-(repo, skill) cooldowns, the rotation index is the starting point
// and we walk forward to the first skill not in cooldown. Returns null if
// every skill in the rotation is in cooldown (caller should treat the repo
// as ineligible and try the next candidate).
function nextSkillFor(repo: string, now: number): string | null {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM issues WHERE type='cron' AND project=?`,
    )
    .get(repo);
  const n = row?.n ?? 0;
  const startIdx = n % skills.length;
  for (let off = 0; off < skills.length; off++) {
    const skill = skills[(startIdx + off) % skills.length]!;
    if (!inCooldown(repo, skill, now)) return skill;
  }
  return null;
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

// Last cron task created for the specific (repo, skill) combo. We match on
// the canonical title (`hygiene: <repo> — /<skill>`) since the issues table
// has no dedicated `skill` column and we don't want to add a migration just
// to throttle cron cadence.
function lastCreatedForSkill(repo: string, skill: string): number | null {
  const row = db
    .query<{ ts: number | null }, [string, string]>(
      `SELECT MAX(created_at) AS ts FROM issues WHERE type='cron' AND project=? AND title=?`,
    )
    .get(repo, `hygiene: ${repo} — /${skill}`);
  return row?.ts ?? null;
}

// Is the (repo, skill) combo currently in cooldown? A repo with no entry, or
// a skill missing from the repo's entry, has no cooldown (rotation cadence
// applies). A combo that has never fired is also not in cooldown — the
// first run of a new cadence override should still happen on schedule.
function inCooldown(repo: string, skill: string, now: number): boolean {
  const days = cadence[repo]?.[skill];
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return false;
  const last = lastCreatedForSkill(repo, skill);
  if (last === null) return false;
  return now - last < Math.floor(days * 86400);
}

let pick: { repo: string; skill: string } | null = null;
const now = Math.floor(Date.now() / 1000);
const candidates = repos
  .map((repo, idx) => ({ repo, idx, last: lastCreatedFor(repo) }))
  .filter((c) => !hasOpenHygiene(c.repo))
  .sort((a, b) => {
    if (a.last === null && b.last !== null) return -1;
    if (a.last !== null && b.last === null) return 1;
    if (a.last !== b.last) return (a.last ?? 0) - (b.last ?? 0);
    return a.idx - b.idx;
  });
for (const c of candidates) {
  const skill = nextSkillFor(c.repo, now);
  if (skill) {
    pick = { repo: c.repo, skill };
    break;
  }
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
