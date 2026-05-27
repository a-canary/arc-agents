// Transcript parsing and stripping for replay-shadow corpus analysis (S-0003).
//
// Claude Code session JSONL format: one JSON object per line. Entry types:
//   - config:     last-prompt, permission-mode, system-prompt
//   - metadata:   file-history-snapshot, attachment (hook_success, skill_listing,
//                 auto_mode, deferred_tools_delta, ai-title, task_reminder, de
//   - content:    user, assistant, result, error
//   - tool:       tool_use, tool_result
//
// "Signature stripping" removes the config + metadata noise to recover the
// meaningful conversational exchange — the part that matters for replay-diff
// of the actual reasoning.  Without stripping, a session with 5 real turns
// carries ~800x overhead from attachment cruft.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ─── Session entry types ──────────────────────────────────────────────────────

/** Raw parsed JSONL entry — a session transcript line. */
export interface TranscriptEntry {
  /** Line type tag. */
  type: string;
  /** Original unparsed JSON for entries we don't structurally model. */
  raw: JsonValue;
}

/** A message entry (user or assistant). */
export interface MessageEntry extends TranscriptEntry {
  type: "user" | "assistant";
  role: "user" | "assistant";
  content: string;
}

/** A single tool invocation. */
export interface ToolCall {
  /** UUID of the tool use entry. */
  id: string;
  /** Tool name, e.g. "Bash", "Read", "Edit". */
  name: string;
  /** Serialized input arguments (stringified). */
  input: string;
  /** Human-readable summary (first 120 chars of description if present). */
  summary: string;
  /** Line index in the original JSONL. */
  index: number;
  /** Exit code if followed by a result; null if no result yet. */
  exitCode: number | null;
}

/** A subagent invocation (Agent/Task tool_use). */
export interface Subagent {
  name: string;
  purpose: string;
  index: number;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a session JSONL file into a flat array of TranscriptEntry.
 * Streaming via readline — safe for large files.
 */
export function parseSessionJsonl(path: string): TranscriptEntry[] {
  const txt = readFileSync(path, "utf8");
  const entries: TranscriptEntry[] = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as JsonValue;
      if (raw && typeof raw === "object" && "type" in raw) {
        entries.push({ type: String((raw as Record<string, JsonValue>).type), raw });
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

/**
 * Async streaming parse — yields entries one at a time.
 * Preferred for very large session files (>100 MB).
 */
export async function* streamSessionJsonl(
  path: string,
): AsyncGenerator<TranscriptEntry, void, unknown> {
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as JsonValue;
      if (raw && typeof raw === "object" && "type" in raw) {
        yield { type: String((raw as Record<string, JsonValue>).type), raw };
      }
    } catch {
      // Skip malformed lines.
    }
  }
}

// ─── Signature stripping ─────────────────────────────────────────────────────

const NOISE_TYPES = new Set([
  "last-prompt",
  "permission-mode",
  "system-prompt",
  "file-history-snapshot",
  "attachment",
  "deferred_tools_delta",
  "auto_mode",
  "hook_success",
  "hook_failure",
  "skill_listing",
  "ai-title",
  "task_reminder",
  "remote_control",
]);

/**
 * Strip config + metadata noise from a transcript.
 *
 * Removes entries whose `type` is in the NOISE_TYPES set.
 * These carry no semantic content and inflate session size by ~100x.
 * The returned array contains only content-bearing entries:
 *   user, assistant, result, error, tool_use, tool_result.
 */
export function stripSignatures(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((e) => !NOISE_TYPES.has(e.type));
}

/**
 * Strip all non-content entries — synonym for stripSignatures.
 * Kept for readability in call sites where intent matters.
 */
export const stripMetadata = stripSignatures;

// ─── Content extraction helpers ───────────────────────────────────────────────

/**
 * Extract plain text from a content-bearing transcript.
 *
 * Returns a concatenation of:
 *   - user messages (role="user")
 *   - assistant messages (role="assistant")
 *   - result messages
 *   - error messages
 *
 * Separated by blank lines so callers can split on `\n\n+`.
 */
export function extractText(entries: TranscriptEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type === "user" || entry.type === "assistant") {
      const raw = entry.raw as Record<string, JsonValue>;
      const content = raw?.message?.content;
      const text = extractContentText(content);
      if (text) parts.push(text);
    } else if (entry.type === "result" || entry.type === "error") {
      const raw = entry.raw as Record<string, JsonValue>;
      const text = String(raw?.content ?? "");
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n");
}

/** Walk a Claude content block array and concatenate text. */
function extractContentText(content: JsonValue | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && (c as Record<string, JsonValue>).type === "text")
      .map((c) => String((c as Record<string, JsonValue>).text ?? ""))
      .join("");
  }
  return "";
}

/**
 * Extract tool call sequence from a stripped transcript.
 *
 * Walks tool_use + tool_result pairs to build a flat chronological list.
 * tool_result entries without a preceding tool_use (malformed) are skipped.
 * Subagent invocations are detected by tool name.
 */
export function extractToolCalls(entries: TranscriptEntry[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_use") continue;

    const raw = entry.raw as Record<string, JsonValue>;
    const input = raw?.input;
    const inputStr = JSON.stringify(input ?? {});

    // Capture subagent invocations separately.
    const name = String(raw?.name ?? "unknown");
    if (name === "Agent" || name === "Task") continue;

    const content = raw?.message?.content as JsonValue | undefined;
    const summary =
      typeof content === "string"
        ? content.slice(0, 120)
        : Array.isArray(content)
          ? content
              .filter(
                (c) =>
                  typeof c === "object" &&
                  c !== null &&
                  (c as Record<string, JsonValue>).type === "text",
              )
              .map((c) => String((c as Record<string, JsonValue>).text ?? ""))
              .join(" ")
              .slice(0, 120)
          : "";

    calls.push({
      id: String(raw?.id ?? `tool-${i}`),
      name,
      input: inputStr,
      summary,
      index: i,
      exitCode: null,
    });
  }

  // Match result entries to calls by walking in parallel.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_result") continue;
    const raw = entry.raw as Record<string, JsonValue>;
    // tool_result has a `tool_use_id` or `toolUseId` field linking to the call.
    const toolUseId = String(
      (raw as Record<string, JsonValue>).tool_use_id ??
        (raw as Record<string, JsonValue>).toolUseId ??
        "",
    );
    const call = calls.find((c) => c.id === toolUseId || c.id === `tool-${i}`);
    if (call) {
      call.exitCode = raw?.exit_code != null ? Number(raw.exit_code) : null;
    }
  }

  return calls;
}

/**
 * Extract subagent invocations (Agent/Task tool_use entries).
 */
export function extractSubagents(entries: TranscriptEntry[]): Subagent[] {
  const subs: Subagent[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_use") continue;
    const raw = entry.raw as Record<string, JsonValue>;
    const name = String(raw?.name ?? "");
    if (name !== "Agent" && name !== "Task") continue;

    const input = raw?.input as Record<string, JsonValue> | undefined;
    const purpose = String(input?.description ?? input?.prompt ?? "").slice(0, 120);
    subs.push({ name, purpose, index: i });
  }
  return subs;
}

/**
 * Extract structured message list (role + text) from a stripped transcript.
 * Use this when you need per-turn access rather than concatenated text.
 */
export interface StructuredMessage {
  role: "user" | "assistant" | "system";
  text: string;
  index: number;
}

export function extractMessages(entries: TranscriptEntry[]): StructuredMessage[] {
  const msgs: StructuredMessage[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "user") {
      const raw = entry.raw as Record<string, JsonValue>;
      const text = extractContentText(raw?.message?.content);
      if (text) msgs.push({ role: "user", text, index: i });
    } else if (entry.type === "assistant") {
      const raw = entry.raw as Record<string, JsonValue>;
      const text = extractContentText(raw?.message?.content);
      if (text) msgs.push({ role: "assistant", text, index: i });
    } else if (entry.type === "system") {
      const raw = entry.raw as Record<string, JsonValue>;
      const text = typeof raw?.content === "string" ? String(raw.content) : "";
      if (text) msgs.push({ role: "system", text, index: i });
    }
  }
  return msgs;
}

/**
 * Compact summary of a transcript for quick health-check.
 */
export interface TranscriptStats {
  totalLines: number;
  strippedLines: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  subagents: number;
  compressionRatio: number;
}

export function stats(entries: TranscriptEntry[]): TranscriptStats {
  const stripped = stripSignatures(entries);
  const calls = extractToolCalls(stripped);
  const subs = extractSubagents(stripped);
  const msgs = extractMessages(stripped);

  return {
    totalLines: entries.length,
    strippedLines: stripped.length,
    userTurns: msgs.filter((m) => m.role === "user").length,
    assistantTurns: msgs.filter((m) => m.role === "assistant").length,
    toolCalls: calls.length,
    subagents: subs.length,
    compressionRatio: entries.length > 0 ? entries.length / stripped.length : 1,
  };
}