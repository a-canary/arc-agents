// Parser for `kind=diff_review` event payloads. The merge gate refuses to
// flip state=merged unless the most recent diff_review event parses as a
// JSON object with three required fields:
//
//   reviewer_identity  — string, must differ from the row's claimed_by (no
//                        self-review)
//   reviewed_sha       — 7–40 hex chars, the commit the reviewer inspected
//   verdict            — "pass" | "fail" | "comment"
//
// Pure: no I/O. The caller is responsible for fetching the row + the latest
// event. Backward compat: events whose payload_md does NOT parse as JSON
// (e.g. a worker's stray prose) are rejected with the same refusal — the
// gate is for the new contract, not the legacy "any event exists" check
// (which silently accepted worker self-review; see analysis-1780502957
// Pattern 1).

export type DiffReviewVerdict = "pass" | "fail" | "comment";
export type DiffReviewPayload = {
  reviewer_identity: string;
  reviewed_sha: string;
  verdict: DiffReviewVerdict;
};
export type DiffReviewOk = { ok: true; payload: DiffReviewPayload };
export type DiffReviewFail = { ok: false; reason: string };
export type DiffReviewResult = DiffReviewOk | DiffReviewFail;

export const REVIEWED_SHA_RE = /^[0-9a-f]{7,40}$/i;
export const VERDICT_VALUES: readonly DiffReviewVerdict[] = ["pass", "fail", "comment"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseDiffReviewPayload(raw: string | null | undefined): DiffReviewResult {
  if (!raw || !raw.trim()) {
    return { ok: false, reason: "diff_review event has empty payload_md; emit '{reviewer_identity, reviewed_sha, verdict}' JSON." };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `diff_review payload is not valid JSON: ${(e as Error).message}. Re-run /diff-review and emit the JSON object, not prose.` };
  }
  if (!isRecord(obj)) {
    return { ok: false, reason: `diff_review payload must be a JSON object, got ${Array.isArray(obj) ? "array" : typeof obj}.` };
  }
  for (const key of ["reviewer_identity", "reviewed_sha", "verdict"] as const) {
    if (!(key in obj)) {
      return { ok: false, reason: `diff_review payload missing required field '${key}'. Required: {reviewer_identity, reviewed_sha, verdict}.` };
    }
  }
  const reviewer_identity = obj.reviewer_identity;
  if (typeof reviewer_identity !== "string" || !reviewer_identity.trim()) {
    return { ok: false, reason: `diff_review 'reviewer_identity' must be a non-empty string (got ${typeof reviewer_identity}).` };
  }
  const reviewed_sha = obj.reviewed_sha;
  if (typeof reviewed_sha !== "string" || !REVIEWED_SHA_RE.test(reviewed_sha)) {
    return { ok: false, reason: `diff_review 'reviewed_sha' must match ${REVIEWED_SHA_RE} (got ${typeof reviewed_sha === "string" ? `"${reviewed_sha}"` : typeof reviewed_sha}).` };
  }
  const verdict = obj.verdict;
  if (typeof verdict !== "string" || !(VERDICT_VALUES as readonly string[]).includes(verdict)) {
    return { ok: false, reason: `diff_review 'verdict' must be one of ${VERDICT_VALUES.join("|")} (got ${typeof verdict === "string" ? `"${verdict}"` : typeof verdict}).` };
  }
  return { ok: true, payload: { reviewer_identity: reviewer_identity.trim(), reviewed_sha, verdict: verdict as DiffReviewVerdict } };
}

// Returns null when independent, or a refusal string naming the offender.
// `workerIdentity` is the row's claimed_by — typically the worker's tmux
// session id (e.g. "arc-worker-a-7kcc01") or "cli" for unauthed writes.
// Equal identities (case-insensitive after trim) are treated as self-review.
export function checkReviewerIndependence(
  reviewerIdentity: string,
  workerIdentity: string | null | undefined,
): string | null {
  const w = (workerIdentity ?? "").trim();
  if (!w) return null; // legacy rows with no claimed_by can't fail this check
  if (reviewerIdentity.toLowerCase() === w.toLowerCase()) {
    return `refuse merged: diff_review reviewer_identity='${reviewerIdentity}' matches the row's claimed_by ('${w}') — self-review is not allowed. Spawn an independent reviewer subagent (no shared reasoning trace) and emit a different reviewer_identity.`;
  }
  return null;
}
