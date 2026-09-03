// Classify a failed task into low-risk (auto-decompose into slices) vs
// needs-HITL (open an HITL row for owner review). Pure: failed row + its
// event log → verdict, no DB writes.
//
// Classification is structural, NOT prose-driven. Workers supply a lot of
// the text the legacy version used to substring-match (title, body_md,
// evidence_md, event payloads); letting them steer their own failure
// disposition is the worker-self-triage attack surface called out by PRD
// enforce-merge-truth-code-verified-eviden §"failed-classifier rewrite".
//
// Decision tree:
//   1. `type` is HITL or security → needs-HITL (the row was filed for a
//      human to own; auto-decompose would erase that contract).
//   2. Any structured failure kind in LOW_RISK_EVENT_KINDS appears in the
//      event log → low-risk (a value the harness emitted is the single
//      trustworthy signal that the failure is benign + reproducible).
//   3. Everything else → needs-HITL (conservative; unknown = the owner
//      looks). Specifically: free-text evidence mention of "test" no
//      longer short-circuits to low-risk. A worker writing "the test
//      failed" cannot trick the classifier into splitting-and-cancelling a
//      real defect — only an actual `kind='test-fail'` event counts.

export type FailedRow = {
  id: string;
  type: string;
  title: string;
  body_md: string;
  evidence_md: string | null;
};

export type FailedEvent = {
  kind: string;
  payload_md: string | null;
};

export type Classification =
  | { verdict: "low-risk"; reasons: string[] }
  | { verdict: "needs-HITL"; reasons: string[] };

// Structured kinds the harness / hooks emit to mark a failure as safely
// auto-decomposable. Membership in this enum is the ONLY low-risk signal.
// Adding a kind here is a deliberate, code-level change — the only way for
// a worker to influence triage is to make the harness emit the kind.
// `budget-blocked` was already a CHECK member (see migrate 002/013); the
// others (`test-fail`, `tool-fail`, `timeout`) come online in migrate 029.
export const LOW_RISK_EVENT_KINDS: readonly string[] = [
  "test-fail",
  "budget-blocked",
  "tool-fail",
  "timeout",
];

export function classifyFailed(row: FailedRow, events: FailedEvent[]): Classification {
  const reasons: string[] = [];

  // 1. Type-based HITL escalation. Conservative: any row type whose contract
  // is human ownership stays human-owned regardless of what the event log
  // shows. This is the only escalation rule that survives `kind` not
  // appearing in the event log (the row's static type is the second
  // trustworthy signal alongside event kinds).
  if (row.type === "HITL" || row.type === "security") {
    return { verdict: "needs-HITL", reasons: [`type=${row.type} requires human review`] };
  }

  // 2. Structured event-kind match. `events.some(...)` is the only place a
  // low-risk verdict can come from — no substring matching on titles, body,
  // evidence, or event payloads. A presence-only check (no payload parsing)
  // is correct here: the harness decides what each kind means; the
  // classifier decides only that the row IS one of those failures.
  for (const kind of LOW_RISK_EVENT_KINDS) {
    if (events.some((e) => e.kind === kind)) {
      reasons.push(`event kind=${kind} in log`);
      return { verdict: "low-risk", reasons };
    }
  }

  // 3. Unclassifiable → HITL. Per the PRD's user story 7 ("silent
  // auto-decompose cannot swallow real bugs"), default to conservative.
  // The list of reasons names the missing signal so the operator / director
  // can decide whether to file a one-time HITL child or extend the
  // LOW_RISK_EVENT_KINDS enum for this failure shape.
  reasons.push(
    "no structured low-risk event kind in log",
    `looked for: ${LOW_RISK_EVENT_KINDS.join(", ")}`,
  );
  return { verdict: "needs-HITL", reasons };
}
