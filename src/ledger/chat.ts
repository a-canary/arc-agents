// Chat JSONL utilities — ADR 0010 foundation.
// Append-only JSONL log for inline replies + grill sessions.
// Schema: {ts, role:"user"|"assistant", body, blog_id, task_id, spawned:[issue_ids]}
//
// chat lines are append-only. The `spawned` array is updated in-place by the
// triage worker: it re-reads the file, patches the last matching line's
// `spawned` field, and re-writes the file atomically (write to tmp + rename).

import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

// ─── Paths ───────────────────────────────────────────────────────────────────

const DEFAULT_CHAT_ROOT =
  process.env.ARC_CHAT_ROOT ?? join(process.env.HOME ?? "/home/aaron", "vault", "arc-ux", "chat");

/** Resolve arc-ux/chat/<slug>.jsonl path. Slug is blog_id. */
export function chatPath(slug: string, root = DEFAULT_CHAT_ROOT): string {
  return join(root, `${slug}.jsonl`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatLine {
  ts: number;
  role: "user" | "assistant";
  body: string;
  blog_id: string;
  task_id: string;
  spawned: string[];
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** Parse all lines from a JSONL file. Returns [] if file does not exist. */
export function readChat(slug: string, root = DEFAULT_CHAT_ROOT): ChatLine[] {
  const path = chatPath(slug, root);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatLine);
}

/** Get the last chat line for a slug. Returns null if file is empty or absent. */
export function lastChatLine(slug: string, root = DEFAULT_CHAT_ROOT): ChatLine | null {
  const lines = readChat(slug, root);
  return lines[lines.length - 1] ?? null;
}

// ─── Append ─────────────────────────────────────────────────────────────────

/**
 * Append a chat line to arc-ux/chat/<slug>.jsonl.
 * Creates the directory and file if they don't exist.
 */
export function appendChatLine(
  line: Omit<ChatLine, "ts" | "task_id" | "spawned"> & { task_id?: string; spawned?: string[] },
  root = DEFAULT_CHAT_ROOT,
): ChatLine {
  const slug = line.blog_id;
  const dir = dirname(chatPath(slug, root));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const full: ChatLine = {
    ts: Math.floor(Date.now() / 1000),
    role: line.role,
    body: line.body,
    blog_id: line.blog_id,
    task_id: line.task_id ?? randomUUID(),
    spawned: line.spawned ?? [],
  };

  const path = chatPath(slug, root);
  writeFileSync(path, JSON.stringify(full) + "\n", { flag: "a", encoding: "utf8" });
  return full;
}

// ─── Update spawned (triage worker) ────────────────────────────────────────

/**
 * Update the `spawned` array on the last chat line whose `task_id` matches.
 * Re-writes the file atomically: write to tmp, then rename.
 * Returns the updated ChatLine, or null if no matching line found.
 */
export function updateSpawned(
  slug: string,
  taskId: string,
  spawned: string[],
  root = DEFAULT_CHAT_ROOT,
): ChatLine | null {
  const path = chatPath(slug, root);
  if (!existsSync(path)) return null;

  const lines = readChat(slug, root);
  // Find last line with matching task_id
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.task_id === taskId) { idx = i; break; }
  }
  if (idx === -1) return null;

  const existing = lines[idx]!;
  lines[idx] = { ...existing, spawned };
  const tmp = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { encoding: "utf8" });
  // Atomic rename
  try {
    renameSync(tmp, path);
  } catch {
    // ignore — tmp may already be gone or path already updated
  }
  return lines[idx]!;
}

// ─── Read chat lines pending triage ─────────────────────────────────────────

/**
 * Find chat lines that are user role, non-empty body, and have empty spawned array
 * (i.e. not yet triaged).
 */
export function pendingTriageLines(slug: string, root = DEFAULT_CHAT_ROOT): ChatLine[] {
  return readChat(slug, root).filter(
    (l) => l.role === "user" && l.body.trim().length > 0 && l.spawned.length === 0,
  );
}
