/**
 * Director-brief partitioner (pure deep module — PRD slice 6).
 *
 * Takes the three INJECTED data sources of a project group and partitions them
 * into one straight read: what's DONE (merged commits from git log), what's
 * CURRENT (in-flight ledger work), and what's NEXT (queued/blocked ledger work
 * plus open feedback). Each bucket is capped, and a definitive size hint is
 * emitted only when the source was truncated. AXI-conformant: definitive empty
 * states (always an array), explicit size hints.
 *
 * Pure: no I/O, no deps, no global/Date/Math/console, no classes. The CLI verb
 * in bin/ledger.ts is the only thing that does I/O — it gathers the three
 * sources, calls brief(), and renders via toon-encode.
 */

export interface GitLogEntry {
  sha: string;
  subject: string;
}

export interface LedgerRow {
  id: string;
  title: string;
  state: string;
  claimedBy?: string;
}

export interface FeedbackRow {
  id: string;
  summary: string;
}

export interface BriefItem {
  kind: "done" | "current" | "next";
  ref: string;
  label: string;
}

export interface Brief {
  done: BriefItem[];
  current: BriefItem[];
  next: BriefItem[];
  /** Size hint per bucket, present only when that bucket's source was truncated. */
  hints: { done?: string; current?: string; next?: string };
}

/** In-flight states → the "current" bucket. */
const CURRENT_STATES = new Set(["claimed", "wip", "review"]);
/** Queued/blocked states → the "next" bucket (feedback follows after these). */
const NEXT_STATES = new Set(["ready", "blocked"]);

const DEFAULT_CAP = 20;

/**
 * Cap a fully-built bucket and produce its size hint.
 * Returns the (possibly truncated) items plus the hint string when the source
 * had MORE than `cap` items — otherwise the hint is undefined (absent).
 */
function capBucket(
  items: BriefItem[],
  cap: number,
): { items: BriefItem[]; hint?: string } {
  const total = items.length;
  if (total > cap) {
    return { items: items.slice(0, cap), hint: `showing ${cap} of ${total}` };
  }
  return { items };
}

export function brief(
  gitLog: GitLogEntry[],
  ledgerRows: LedgerRow[],
  feedback: FeedbackRow[],
  opts?: { cap?: number },
): Brief {
  const requested = opts?.cap;
  // Negative/undefined cap → default; cap of 0 is honored.
  const cap =
    requested === undefined || requested < 0 ? DEFAULT_CAP : requested;

  const doneAll: BriefItem[] = gitLog.map((c) => ({
    kind: "done",
    ref: c.sha,
    label: c.subject,
  }));

  const currentAll: BriefItem[] = ledgerRows
    .filter((r) => CURRENT_STATES.has(r.state))
    .map((r) => ({ kind: "current", ref: r.id, label: r.title }));

  // next = ledger-next items FIRST, then all feedback (grouped in after).
  const nextAll: BriefItem[] = [
    ...ledgerRows
      .filter((r) => NEXT_STATES.has(r.state))
      .map((r): BriefItem => ({ kind: "next", ref: r.id, label: r.title })),
    ...feedback.map((f): BriefItem => ({
      kind: "next",
      ref: f.id,
      label: f.summary,
    })),
  ];

  const done = capBucket(doneAll, cap);
  const current = capBucket(currentAll, cap);
  const next = capBucket(nextAll, cap);

  const hints: Brief["hints"] = {};
  if (done.hint !== undefined) hints.done = done.hint;
  if (current.hint !== undefined) hints.current = current.hint;
  if (next.hint !== undefined) hints.next = next.hint;

  return { done: done.items, current: current.items, next: next.items, hints };
}
