// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// Classify a failed task into low-risk (auto-decompose into new tasks) vs
// needs-HITL (open an HITL row for owner review). Pure function over the
// failed row + its event log; no db writes.
//
// "Low-risk" rule of thumb:
//   - test-only failures (evidence mentions "test" and not "prod"/"data loss")
//   - dependency unavailable (event kind 'budget-blocked' or note matching upstream)
//   - re-runnable: title or body mentions "smoke", "benchmark", "check"
// Anything else → HITL. Conservative on purpose.

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

const LOW_RISK_TITLE_HINTS = ["smoke", "benchmark", "check", "audit", "lint", "format"];
const HIGH_RISK_PHRASES = [
  "data loss",
  "data corrupt",
  "prod outage",
  "credentials",
  "secret",
  "delete",
  "drop table",
  "destructive",
];

export function classifyFailed(row: FailedRow, events: FailedEvent[]): Classification {
  const reasons: string[] = [];
  const haystack = [
    row.title,
    row.body_md,
    row.evidence_md ?? "",
    ...events.map((e) => e.payload_md ?? ""),
  ]
    .join("\n")
    .toLowerCase();

  for (const p of HIGH_RISK_PHRASES) {
    if (haystack.includes(p)) {
      reasons.push(`high-risk phrase: "${p}"`);
    }
  }
  if (reasons.length > 0) return { verdict: "needs-HITL", reasons };

  // HITL types always escalate.
  if (row.type === "HITL" || row.type === "security") {
    return { verdict: "needs-HITL", reasons: [`type=${row.type} requires human review`] };
  }

  if (events.some((e) => e.kind === "budget-blocked")) {
    reasons.push("budget-blocked event in log");
    return { verdict: "low-risk", reasons };
  }

  const title = row.title.toLowerCase();
  if (LOW_RISK_TITLE_HINTS.some((h) => title.includes(h))) {
    reasons.push(`title matches low-risk hint`);
    return { verdict: "low-risk", reasons };
  }

  if ((row.evidence_md ?? "").toLowerCase().includes("test")) {
    reasons.push("evidence mentions test-only failure");
    return { verdict: "low-risk", reasons };
  }

  return { verdict: "needs-HITL", reasons: ["no low-risk signal matched"] };
}
