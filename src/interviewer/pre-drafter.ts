// S8 — Interviewer pre-drafter (SLICE-PLAN-arc-webui.md).
//
// On chat-in rows arriving at rank ≤ TOP_N, generate `draft_md` containing a
// recommended draft plus 2-3 alternatives. Result is cached on the row.
// Cache is invalidated (re-written) when a row's rank crosses the threshold,
// or when the source body changes.
//
// Schema note: post-migration, what the slice plan calls "chat_in" rows are
// modeled as `kind='event' AND urgency='interactive' AND source_module='arc-chat'`.
// See src/ledger/migrate.ts (chat_in → event remap).
//
// The actual draft text comes from an injectable `DraftGenerator`. The default
// generator is template-based so the scaffold can land before S5's LLM hookup.
//
// Activation: gated by `ARC_PREDRAFTER_ENABLED=1` at the CLI layer (bin/
// pre-drafter.ts). Library is dependency-free of env so tests stay clean.

import type { Database } from "bun:sqlite";

export const TOP_N = 3;
export const ALT_COUNT = 2; // 2 alternatives + 1 primary = 3 total options

export type ChatInRow = {
  id: string;
  title: string;
  body_md: string;
  thread_id: string | null;
  priority: number | null;
  updated_at: number;
  draft_md: string | null;
};

export type DraftPayload = {
  primary: string;
  alternatives: string[];
  // Fingerprint of source row used to generate this draft. Re-generation skips
  // when fingerprint matches.
  source_fp: string;
  generated_at: number;
};

export type DraftGenerator = (row: ChatInRow) => { primary: string; alternatives: string[] };

// Cheap content fingerprint. Changes when the message body or its rank
// position changes — both should trigger a regen.
export function fingerprint(row: ChatInRow, rank: number): string {
  // Body hash + rank. We don't need cryptographic strength; collisions waste a
  // regen but don't corrupt state.
  let h = 0;
  for (let i = 0; i < row.body_md.length; i++) {
    h = (h * 31 + row.body_md.charCodeAt(i)) | 0;
  }
  return `r${rank}|h${h}`;
}

// Default generator: template-based. Echoes the user's message back as a
// proposed acknowledgement, plus two stock alternative framings. S5 will swap
// this for an LLM-backed generator.
export const templateGenerator: DraftGenerator = (row) => {
  const subject = row.title.replace(/[.?!]+$/, "");
  return {
    primary: `Acknowledged: ${subject}. Proceeding with the requested action.`,
    alternatives: [
      `Could you clarify "${subject}"? Specifically, what outcome should the reply produce?`,
      `Deferring "${subject}" for now — will revisit once current in-flight work completes.`,
    ],
  };
};

export function selectTopChatIn(db: Database, n: number = TOP_N): ChatInRow[] {
  return db
    .query<ChatInRow, [number]>(
      `SELECT id, title, body_md, thread_id, priority, updated_at, draft_md
         FROM issues
        WHERE kind = 'event'
          AND urgency = 'interactive'
          AND source_module = 'arc-chat'
          AND state NOT IN ('merged','cancelled','failed')
          AND paused = 0
        ORDER BY COALESCE(priority, 999) ASC, updated_at DESC
        LIMIT ?`,
    )
    .all(n);
}

export function parseDraft(draft_md: string | null): DraftPayload | null {
  if (!draft_md) return null;
  try {
    const parsed = JSON.parse(draft_md);
    if (typeof parsed?.primary === "string" && Array.isArray(parsed?.alternatives)) {
      return parsed as DraftPayload;
    }
  } catch {
    // Pre-S8 rows may contain plain markdown. Treat as opaque; force regen.
  }
  return null;
};

export function serializeDraft(p: DraftPayload): string {
  return JSON.stringify(p);
}

export type RunResult = {
  generated: string[]; // ids that got a new draft
  unchanged: string[]; // ids whose cached draft was still valid
  cleared: string[]; // ids that fell out of top-N and had draft cleared
};

// One pass. Idempotent. Safe to call repeatedly (e.g. on every ledger tick or
// after a chat_in insert). Caller decides cadence.
export function runPreDrafter(
  db: Database,
  opts: { generator?: DraftGenerator; n?: number; now?: () => number } = {},
): RunResult {
  const gen = opts.generator ?? templateGenerator;
  const n = opts.n ?? TOP_N;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const top = selectTopChatIn(db, n);
  const topIds = new Set(top.map((r) => r.id));
  const result: RunResult = { generated: [], unchanged: [], cleared: [] };

  // Generate or refresh for top-N.
  for (let i = 0; i < top.length; i++) {
    const row = top[i]!;
    const rank = i + 1;
    const fp = fingerprint(row, rank);
    const cached = parseDraft(row.draft_md);
    if (cached && cached.source_fp === fp) {
      result.unchanged.push(row.id);
      continue;
    }
    const { primary, alternatives } = gen(row);
    const payload: DraftPayload = {
      primary,
      alternatives: alternatives.slice(0, ALT_COUNT),
      source_fp: fp,
      generated_at: now(),
    };
    db.run("UPDATE issues SET draft_md = ?, updated_at = ? WHERE id = ?", [
      serializeDraft(payload),
      now(),
      row.id,
    ] as never);
    result.generated.push(row.id);
  }

  // Invalidate any chat_in row that has a draft but is no longer in top-N.
  // Keeps the cache aligned with the visible HITL panel.
  const stale = db
    .query<{ id: string }, []>(
      `SELECT id FROM issues
        WHERE kind = 'event'
          AND urgency = 'interactive'
          AND source_module = 'arc-chat'
          AND draft_md IS NOT NULL
          AND state NOT IN ('merged','cancelled','failed')`,
    )
    .all();
  for (const s of stale) {
    if (topIds.has(s.id)) continue;
    db.run("UPDATE issues SET draft_md = NULL, updated_at = ? WHERE id = ?", [
      now(),
      s.id,
    ] as never);
    result.cleared.push(s.id);
  }

  return result;
}
