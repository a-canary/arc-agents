// Parser for `kind=in_place_review` event payloads. The merge gate refuses
// to flip state=merged under the --in-place route unless the most recent
// in_place_review event parses as a JSON object with two required fields:
//
//   reviewer_identity  — string, must differ from the row's claimed_by (no
//                        self-review). Independence reuses
//                        checkReviewerIndependence from diff-review.ts so
//                        the two gates share one identity rule.
//   justification      — short string (≤280 chars), the human-readable
//                        reason the reviewer cleared this in-place merge
//                        in absence of a PR or local-sha.
//
// Required because PRD enforce-merge-truth-code-verified-eviden User Story
// 5 ("I want `--in-place` to require an independent in-place-review event,
// so ghost merges cannot be waved through on a 280-char note") and the
// "In-place route" implementation decision (separate event kind from
// diff_review; in_place_review is structurally distinct so a worker's
// diff_review cannot wave through an in-place ghost merge, nor vice versa).
//
// Pure: no I/O. The caller (bin/ledger.ts update --state=merged --in-place)
// fetches the row + the latest in_place_review event before calling.
//
// Ponytail: one identity rule across both gates beats two that drift —
// checkReviewerIndependence is reused verbatim from diff-review.ts.

import { checkReviewerIndependence } from "./diff-review";

export type InPlaceReviewPayload = {
  reviewer_identity: string;
  justification: string;
};

export type InPlaceReviewOk = { ok: true; payload: InPlaceReviewPayload };
export type InPlaceReviewFail = { ok: false; reason: string };
export type InPlaceReviewResult = InPlaceReviewOk | InPlaceReviewFail;

// Same 280-char ceiling the CLI enforces on --evidence for --in-place
// (bin-ledger-ts-restrict-in-place-to-requi). The event body MUST be a
// short reviewer-supplied justification, not a duplicate of the worker's
// --evidence note; bounded length is the easy knob that punts a long
// ghost-merge essay back into the rejection pile.
export const JUSTIFICATION_MAX = 280;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseInPlaceReviewPayload(raw: string | null | undefined): InPlaceReviewResult {
  if (!raw || !raw.trim()) {
    return {
      ok: false,
      reason: `in_place_review event has empty payload_md; emit '{"reviewer_identity","justification"}' JSON.`,
    };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: `in_place_review payload is not valid JSON: ${(e as Error).message}. Re-run the in-place review and emit the JSON object, not prose.`,
    };
  }
  if (!isRecord(obj)) {
    return {
      ok: false,
      reason: `in_place_review payload must be a JSON object, got ${Array.isArray(obj) ? "array" : typeof obj}.`,
    };
  }
  for (const key of ["reviewer_identity", "justification"] as const) {
    if (!(key in obj)) {
      return {
        ok: false,
        reason: `in_place_review payload missing required field '${key}'. Required: {reviewer_identity, justification}.`,
      };
    }
  }
  const reviewer_identity = obj.reviewer_identity;
  if (typeof reviewer_identity !== "string" || !reviewer_identity.trim()) {
    return {
      ok: false,
      reason: `in_place_review 'reviewer_identity' must be a non-empty string (got ${typeof reviewer_identity}).`,
    };
  }
  const justification = obj.justification;
  if (typeof justification !== "string" || !justification.trim()) {
    return {
      ok: false,
      reason: `in_place_review 'justification' must be a non-empty string (got ${typeof justification}).`,
    };
  }
  if (justification.length > JUSTIFICATION_MAX) {
    return {
      ok: false,
      reason: `in_place_review 'justification' must be ≤${JUSTIFICATION_MAX} chars (got ${justification.length}). Concise justifications are intentional — long ones are a ghost-merge smell.`,
    };
  }
  return {
    ok: true,
    payload: {
      reviewer_identity: reviewer_identity.trim(),
      justification: justification.trim(),
    },
  };
}

// Identity-independence reused from diff-review. The diff_review gate and
// the in_place_review gate share one rule so a self-review cannot pass
// either side by accident.
export function checkInPlaceReviewerIndependence(
  reviewerIdentity: string,
  workerIdentity: string | null | undefined,
): string | null {
  return checkReviewerIndependence(reviewerIdentity, workerIdentity);
}
