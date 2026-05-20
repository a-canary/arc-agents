// Thread replay for cold-starting workers.
//
// One module owns both the SQL filter (which kinds + source_module count as
// part of a chat thread) AND the speaker-mapping render. Previously these
// lived in two files (bin/ledger.ts render-prompt + src/worker/templates.ts
// renderThreadReplay) with the row shape as the only contract — silent
// breakage if either side drifted.

import type { Database } from "bun:sqlite";

type ThreadTurn = {
  id: string;
  kind: string;
  title: string;
  body: string;
};

/**
 * Returns the rendered markdown replay block for a thread, suitable for
 * pre-pending to a worker system prompt. Empty string when the thread has
 * no prior turns (so callers can join with `\n\n` without producing blank
 * sections).
 *
 * `current_id` is excluded so the worker isn't shown its own current task
 * as "prior history".
 */
export function loadThreadContext(
  db: Database,
  thread_id: string,
  current_id: string,
): string {
  const turns = db
    .query<ThreadTurn, [string, string]>(
      `SELECT id, kind, title, COALESCE(body_md, '') AS body
       FROM issues
       WHERE thread_id=? AND id != ? AND kind IN ('event','reply') AND source_module='arc-chat'
       ORDER BY id`,
    )
    .all(thread_id, current_id);
  return renderThreadReplay(turns);
}

function renderThreadReplay(turns: ThreadTurn[]): string {
  if (turns.length === 0) return "";
  const lines = turns.map((t) => {
    const speaker = t.kind === "event" ? "user" : "you";
    const body = t.body.trim() || t.title;
    return `[${speaker}] ${body}`;
  });
  return `Prior turns in this thread (oldest first):\n${lines.join("\n")}`;
}
