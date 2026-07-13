// Pure classifier: given one PR record, decide keep/close/escalate.
// No I/O — callers (hygiene-tick, gh CLI wrappers) own evidence-gathering
// and side effects. See PRD stale-draft-pr-sweep-auto-close-dead-dra.

export type PrGateState = "clean" | "red" | "unknown";

export type PrRecord = {
  draft: boolean;
  ageDays: number;
  gateState: PrGateState;
  headBranchExists: boolean;
};

export type StaleVerdict = "keep" | "close" | "escalate";

export function classifyStalePr(
  pr: PrRecord,
  thresholdDays = 14,
): StaleVerdict {
  if (!pr.draft || pr.ageDays < thresholdDays) return "keep";
  if (!pr.headBranchExists || pr.gateState === "red") return "close";
  return "escalate";
}
