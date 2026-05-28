#!/usr/bin/env bun
// bin/deploy-preview.ts — cron-scheduled probe per ADR 0007.
//
// Reads candidate issues from ~/vault/ledger.db, probes each PR for a
// deploy preview URL via the GitHub API, and emits `deploy_preview` events
// (skipped when a previous probe for the same issue already succeeded).
//
// Usage:
//   bun bin/deploy-preview.ts [--db <path>] [--limit N] [--dry] [--once]
//
// Exit codes:
//   0 — completed (even if no candidates / no previews)
//   1 — fatal (db open failure, etc.)
//
// Token resolution: env GITHUB_TOKEN, else `pass show github/api-token`
// (silent failure — public PRs work unauthenticated, just rate-limited).

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { probeBatch, formatEventPayload, type CandidateRow } from "../src/ledger/deploy-preview";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return args[i + 1];
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}
const DRY = has("dry");
const LIMIT = Number.parseInt(flag("limit") ?? "20", 10);
const DB_PATH = flag("db") ?? join(process.env.HOME ?? "/home/aaron", "vault", "ledger.db");

function loadToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync("pass", ["show", "github/api-token"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim().split("\n")[0] ?? null;
  return null;
}

function listCandidates(db: Database, limit: number): CandidateRow[] {
  // Candidates: PR url set, no successful deploy_preview event yet.
  // Exclude rows in terminal states (merged/cancelled) — once merged the
  // preview URL is moot and we don't want to keep probing forever.
  return db.query<CandidateRow, [number]>(`
    SELECT i.id AS id, i.pr_url AS pr_url
      FROM issues i
     WHERE i.pr_url IS NOT NULL
       AND i.state NOT IN ('merged','cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM issue_events e
          WHERE e.issue_id = i.id
            AND e.kind = 'deploy_preview'
            AND e.payload_md LIKE 'provider:%'
       )
     ORDER BY i.updated_at DESC
     LIMIT ?
  `).all(limit);
}

async function main(): Promise<number> {
  let db: Database;
  try {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL;");
  } catch (e: unknown) {
    console.error(`fatal: could not open ${DB_PATH}: ${(e as Error).message}`);
    return 1;
  }
  const candidates = listCandidates(db, LIMIT);
  if (candidates.length === 0) {
    console.log(JSON.stringify({ candidates: 0, emitted: 0 }));
    return 0;
  }
  const token = loadToken();
  const results = await probeBatch(candidates, { fetchFn: fetch as unknown as typeof globalThis.fetch, token });
  let emitted = 0;
  for (const r of results) {
    if (!r.preview_url) continue;
    const payload = formatEventPayload(r);
    if (DRY) {
      console.log(JSON.stringify({ id: r.id, would_emit: payload }));
    } else {
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'deploy_preview', 'deploy-preview', ?)`,
        [r.id, payload],
      );
    }
    emitted++;
  }
  console.log(JSON.stringify({ candidates: candidates.length, emitted, dry: DRY }));
  return 0;
}

process.exit(await main());
