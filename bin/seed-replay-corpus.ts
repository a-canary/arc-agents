#!/usr/bin/env bun
// seed-replay-corpus — build initial replay-shadow corpus (S-0003).
//
// Builds tests/replay-corpus/<task-id>/ for N terminal worker turns from the
// live ledger, paired with their claude session JSONLs. Conforms to
// skills/replay-shadow/FIXTURE-SCHEMA.md (PR #36). One-shot seeder; future
// rotation is a separate concern.
//
//   bun bin/seed-replay-corpus.ts --count 30 [--out tests/replay-corpus]

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { parseSessionJsonl, stripSignatures, stats } from "../src/replay/transcript";

type Row = {
  id: string; project: string; parent_id: string|null; title: string;
  body_md: string|null; type: string; state: string; kind: string;
  tier: string; claimed_by: string; claimed_at: number; updated_at: number;
  worktree_path: string|null; branch: string|null; pr_url: string|null;
  evidence_md: string|null; thread_id: string|null;
};

type Evt = {
  seq: number; ts: number; agent: string; kind: string;
  payload_md: string|null; issue_id: string;
};

function arg(name: string, dflt?: string): string|undefined {
  const i = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return dflt;
  const a = process.argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=")+1) : process.argv[i+1];
}

const COUNT = Number(arg("count", "30"));
const OUT_ROOT = arg("out", "tests/replay-corpus")!;
const REPO_ROOT = process.cwd();
const DB_PATH = arg("db", "/home/aaron/vault/ledger.db")!;
const SESSIONS_DIR = "/home/aaron/.claude/projects/-home-aaron-repos-arc-agents";

const db = new Database(DB_PATH, { readonly: true });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function indexSessions(): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const txt = readFileSync(join(SESSIONS_DIR, f), "utf8");
      const m = txt.match(/arc-worker-[a-z]-[a-z0-9]+/g);
      if (m) {
        for (const w of new Set(m)) (idx[w] ||= []).push(f);
      }
    } catch {}
  }
  return idx;
}

function pickSession(sessions: string[], claimedAt: number, updatedAt: number): string | null {
  // Pick the session whose file mtime is closest to the worker's claim window.
  let best: { f: string; score: number } | null = null;
  for (const f of sessions) {
    const fp = join(SESSIONS_DIR, f);
    const st = Bun.file(fp).size;
    if (!st) continue;
    // Use line count proxy + filename. Prefer largest session containing the id.
    const score = st;
    if (!best || score > best.score) best = { f, score };
  }
  return best?.f ?? null;
}

function eventsForWorker(workerId: string, claimedAt: number): Evt[] {
  return db.query(
    "SELECT seq, ts, agent, kind, payload_md, issue_id FROM issue_events WHERE agent = ? AND ts >= ? ORDER BY seq"
  ).all(workerId, claimedAt - 1) as Evt[];
}

function rowAndParents(id: string): Row[] {
  const out: Row[] = [];
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const r = db.query("SELECT * FROM issues WHERE id = ?").get(cur) as Row | null;
    if (!r) break;
    out.push(r);
    cur = r.parent_id;
  }
  return out;
}

function selectCorpus(idx: Record<string,string[]>, limit: number): { row: Row; session: string }[] {
  const rows = db.query(
    "SELECT * FROM issues WHERE state IN ('merged','failed','blocked','cancelled') AND claimed_by LIKE 'arc-worker%' ORDER BY updated_at DESC"
  ).all() as Row[];

  // Diversity: weight by terminal state mix (target ~70% merged, ~15% failed,
  // ~10% blocked, ~5% cancelled — proportional to availability).
  const buckets: Record<string, Row[]> = { merged: [], failed: [], blocked: [], cancelled: [] };
  for (const r of rows) (buckets[r.state] ||= []).push(r);

  const targets: Record<string, number> = {
    merged: Math.round(limit * 0.70),
    failed: Math.round(limit * 0.15),
    blocked: Math.round(limit * 0.10),
    cancelled: Math.max(1, limit - Math.round(limit * 0.95)),
  };

  const picked: { row: Row; session: string }[] = [];
  for (const [state, target] of Object.entries(targets)) {
    let taken = 0;
    for (const r of buckets[state] || []) {
      if (taken >= target) break;
      const sessions = idx[r.claimed_by];
      if (!sessions?.length) continue;
      const s = pickSession(sessions, r.claimed_at, r.updated_at);
      if (!s) continue;
      picked.push({ row: r, session: s });
      taken++;
    }
  }

  // Top up from merged if we fell short.
  if (picked.length < limit) {
    const have = new Set(picked.map(p => p.row.id));
    for (const r of buckets.merged || []) {
      if (picked.length >= limit) break;
      if (have.has(r.id)) continue;
      const sessions = idx[r.claimed_by];
      if (!sessions?.length) continue;
      const s = pickSession(sessions, r.claimed_at, r.updated_at);
      if (s) picked.push({ row: r, session: s });
    }
  }

  return picked.slice(0, limit);
}

function inferTerminatedAt(workerEvts: Evt[], row: Row): number {
  // Last event by the worker mentioning the row, else row.updated_at.
  const ours = workerEvts.filter(e => e.issue_id === row.id);
  return ours.length ? ours[ours.length - 1]!.ts : row.updated_at;
}

function countTranscript(jsonlPath: string): { turns: number; toolCalls: any[]; subagents: any[]; compressionRatio: number } {
  const entries = parseSessionJsonl(jsonlPath);
  const stripped = stripSignatures(entries);
  const s = stats(entries);
  // Reconstruct tool_calls and subagents in the legacy shape for fixture.json compat.
  const toolCalls: any[] = [];
  const subagents: any[] = [];
  for (const entry of stripped) {
    if (entry.type !== "tool_use") continue;
    const raw = entry.raw as Record<string, any>;
    const name = String(raw?.name ?? "");
    const inputStr = JSON.stringify(raw?.input ?? {});
    if (name === "Agent" || name === "Task") {
      subagents.push({
        seq: toolCalls.length + subagents.length,
        subagent_type: name,
        purpose: (raw?.input?.description ?? "").slice(0, 120),
      });
    } else {
      toolCalls.push({
        seq: toolCalls.length,
        tool: name,
        input_sha256: sha(inputStr),
        exit_code: null,
        elapsed_ms: null,
      });
    }
  }
  return { turns: s.userTurns + s.assistantTurns, toolCalls, subagents, compressionRatio: s.compressionRatio };
}

function repoSha(): string {
  try { return require("child_process").execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim(); } catch { return ""; }
}

function buildFixture(row: Row, sessionFile: string): void {
  const fixtureDir = join(REPO_ROOT, OUT_ROOT, row.id);
  mkdirSync(fixtureDir, { recursive: true });

  const sessionSrc = join(SESSIONS_DIR, sessionFile);
  const sessionDst = join(fixtureDir, "session.jsonl");
  copyFileSync(sessionSrc, sessionDst);

  const workerEvts = eventsForWorker(row.claimed_by, row.claimed_at);
  const ourEvts = workerEvts.filter(e => e.issue_id === row.id);
  const ledgerWrites = ourEvts.map(e => ({
    issue_id: e.issue_id,
    event_kind: e.kind,
    payload_md_sha256: sha(e.payload_md ?? ""),
    payload_md_preview: (e.payload_md ?? "").slice(0, 200),
  }));
  const childrenSpawned = workerEvts
    .filter(e => e.kind === "created" && e.issue_id !== row.id)
    .map(e => e.issue_id);

  const seedRows = rowAndParents(row.id);
  for (const cid of childrenSpawned) {
    const c = db.query("SELECT * FROM issues WHERE id = ?").get(cid);
    if (c) seedRows.push(c as Row);
  }
  writeFileSync(join(fixtureDir, "ledger-seed.json"), JSON.stringify(seedRows, null, 2));
  writeFileSync(join(fixtureDir, "ledger-diff.json"), JSON.stringify({
    worker_events: workerEvts,
  }, null, 2));

  const transcript = countTranscript(sessionDst);
  const terminatedAt = inferTerminatedAt(workerEvts, row);

  const fixture = {
    $schema_version: 1,
    fixture_id: row.id,
    captured_at: Math.floor(Date.now() / 1000),
    source: {
      system: "arc-agents",
      system_sha: repoSha(),
      schema_sha: "pending-s-0003b-merge",
    },
    unit: {
      task_id: row.id,
      task_kind: row.kind,
      task_type: row.type,
      task_class: row.tier,
      worker_id: row.claimed_by,
      claimed_at: row.claimed_at,
      terminated_at: terminatedAt,
      terminal_state: row.state,
      parent_id: row.parent_id,
      repo: row.project,
    },
    input: {
      rendered_prompt: null,
      rendered_prompt_sha256: null,
      profile: "developer",
      model: null,
      skill_set: [],
      frame: "afk-worker",
      note: "rendered_prompt unavailable for retro-captured turns; capture-time fixtures will populate.",
    },
    env: {
      git: {
        repo_sha: null,
        branch: row.branch,
      },
      ledger: {
        kind: "rows",
        rows_path: "ledger-seed.json",
      },
      ke: { kind: "none", path: null, cursor: null },
      env_vars: {},
      thread_history: [],
    },
    transcript: {
      session_jsonl: "session.jsonl",
      turn_count: transcript.turns,
      tool_calls: transcript.toolCalls,
      subagent_invocations: transcript.subagents,
      compression_ratio: transcript.compressionRatio,
    },
    output_diff: {
      ledger_writes: ledgerWrites,
      ledger_state_transitions: [
        { issue_id: row.id, from: "claimed", to: row.state },
      ],
      children_spawned: childrenSpawned,
      git: {
        commits: [],
        files_committed: [],
        pr_url: row.pr_url,
      },
      intent_log: [],
    },
    quality: {
      wall_time_seconds: row.updated_at - row.claimed_at,
      token_cost: null,
      terminated_cleanly: ["merged","failed","blocked","cancelled"].includes(row.state),
      human_intervention: false,
      notes: `Retro-captured from session ${sessionFile}. evidence: ${(row.evidence_md ?? "").slice(0,400)}`,
    },
  };

  writeFileSync(join(fixtureDir, "fixture.json"), JSON.stringify(fixture, null, 2));
}

function main() {
  const idx = indexSessions();
  const picked = selectCorpus(idx, COUNT);
  console.log(`selected ${picked.length} turns; writing to ${OUT_ROOT}/`);

  const manifest: any[] = [];
  for (const { row, session } of picked) {
    buildFixture(row, session);
    manifest.push({
      fixture_id: row.id,
      terminal_state: row.state,
      worker_id: row.claimed_by,
      session_jsonl: session,
    });
    console.log(`  ${row.state.padEnd(9)} ${row.id}`);
  }

  writeFileSync(
    join(REPO_ROOT, OUT_ROOT, "MANIFEST.json"),
    JSON.stringify({ count: manifest.length, fixtures: manifest, generated_at: Math.floor(Date.now()/1000) }, null, 2),
  );
  console.log(`wrote ${OUT_ROOT}/MANIFEST.json`);
}

main();
