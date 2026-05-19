#!/usr/bin/env bun
// merger-sweep — survey the open PR queue, decide per-PR action.
//
// Spec lives in ledger row `bin-merger-sweep-ts-drive-merger-over-op`.
// `.claude/agents/merger.md` implements the gate stack; nothing invokes it.
// This thin slice does the partitioning + JSON output only. It does NOT:
//   - invoke the merger
//   - emit HITL prompts (just prints the prompt spec on stdout)
//   - resolve conflicts
//   - wire factory cadence
//
// Doctrine: HITL is emitted only when needed — never per MERGEABLE PR.
// Of the actions below, exactly the `hitl_*` ones encode a question only
// a human can answer (conflict, author divergence, scope blow-out, signal
// conflict between CI and review). Everything else is `ready`, `defer`,
// or `skip` — no human required.
//
// Output: one JSON object per PR on its own line, with keys
//   { pr: number, action: string, reason: string }.
//
// Exit codes: 0 ok (incl. empty queue), 1 unexpected `gh` failure.

import { spawnSync } from "node:child_process";

type Action =
  | "ready"
  | "hitl_conflict"
  | "hitl_author"
  | "hitl_scope"
  | "hitl_ambiguous"
  | "defer"
  | "skip";

type StatusCheck = { conclusion?: string | null; status?: string | null };

type PR = {
  number: number;
  headRefName: string;
  createdAt: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | null | string;
  statusCheckRollup: StatusCheck[];
  labels?: Array<string | { name?: string }>;
  author?: { login?: string };
};

const MIN_AGE_MS = 5 * 60 * 1000;
const PR_LIMIT = 60;

function labelNames(pr: PR): string[] {
  if (!pr.labels) return [];
  return pr.labels
    .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
    .filter((n) => n.length > 0);
}

function hasLabel(pr: PR, name: string): boolean {
  return labelNames(pr).some((n) => n.toLowerCase() === name.toLowerCase());
}

// CI is "green" if every check ran and concluded SUCCESS, or the rollup is empty
// (no required checks). NEUTRAL/SKIPPED count as success. Anything PENDING/IN_PROGRESS
// is not green yet; anything FAILURE/CANCELLED/TIMED_OUT/ACTION_REQUIRED is red.
function ciState(pr: PR): "green" | "pending" | "red" {
  const rollup = pr.statusCheckRollup ?? [];
  if (rollup.length === 0) return "green";
  let pending = false;
  for (const c of rollup) {
    const concl = (c.conclusion ?? "").toUpperCase();
    const status = (c.status ?? "").toUpperCase();
    if (status === "QUEUED" || status === "IN_PROGRESS" || status === "PENDING" || concl === "") {
      pending = true;
      continue;
    }
    if (concl === "SUCCESS" || concl === "NEUTRAL" || concl === "SKIPPED") continue;
    return "red";
  }
  return pending ? "pending" : "green";
}

function ageMs(pr: PR, now: number): number {
  const t = Date.parse(pr.createdAt);
  if (Number.isNaN(t)) return Infinity; // unparseable = treat as old
  return now - t;
}

function decide(pr: PR, now: number): { action: Action; reason: string } {
  if (pr.isDraft) return { action: "skip", reason: "draft" };

  // Scope/author signals win before mergeable state — they encode a human-shaped
  // question even when the merge itself would otherwise be clean.
  if (hasLabel(pr, "slice-guard:fail")) {
    return { action: "hitl_scope", reason: "slice-guard label asks: split or override?" };
  }
  if (hasLabel(pr, "author-lint:divergent")) {
    return {
      action: "hitl_author",
      reason: `author-lint flagged ${pr.author?.login ?? "head"}: trust + merge, or refuse?`,
    };
  }

  if (pr.mergeable === "CONFLICTING") {
    return { action: "hitl_conflict", reason: "non-trivial conflict — human picks resolution path" };
  }
  if (pr.mergeable === "UNKNOWN") {
    return { action: "defer", reason: "mergeable=UNKNOWN — re-check next sweep" };
  }

  if (pr.mergeable === "MERGEABLE") {
    if (ageMs(pr, now) < MIN_AGE_MS) {
      return { action: "skip", reason: "younger than 5min — let CI settle" };
    }
    const ci = ciState(pr);
    if (ci === "pending") return { action: "defer", reason: "CI still running" };
    if (ci === "red") return { action: "skip", reason: "CI red — author drives the fix" };

    // CI green. Now reconcile with review.
    const review = (pr.reviewDecision ?? "").toUpperCase();
    if (review === "CHANGES_REQUESTED") {
      return { action: "skip", reason: "changes requested — author drives" };
    }
    if (review === "REVIEW_REQUIRED") {
      // Signal conflict: CI says go, branch protection says wait. A human owns
      // the call (auto-merge after timeout? request a review? merge anyway?).
      return {
        action: "hitl_ambiguous",
        reason: "CI green but REVIEW_REQUIRED — merge anyway, await review, or skip?",
      };
    }
    // APPROVED or empty (no required review). Hand to merger.
    return {
      action: "ready",
      reason: `invoke merger subagent on #${pr.number} (${pr.headRefName})`,
    };
  }

  return { action: "defer", reason: `unrecognized mergeable=${pr.mergeable}` };
}

function fetchPRs(): PR[] {
  const fields =
    "number,headRefName,createdAt,isDraft,mergeable,reviewDecision,statusCheckRollup,labels,author";
  const res = spawnSync(
    "gh",
    ["pr", "list", "--state", "open", "--json", fields, "--limit", String(PR_LIMIT)],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    process.stderr.write(`merger-sweep: gh pr list failed: ${res.stderr ?? ""}\n`);
    process.exit(1);
  }
  const parsed = JSON.parse(res.stdout || "[]");
  if (!Array.isArray(parsed)) {
    process.stderr.write("merger-sweep: gh pr list did not return an array\n");
    process.exit(1);
  }
  return parsed as PR[];
}

const args = process.argv.slice(2);
// --dry-run is the only behavior right now; the flag exists so callers can be
// explicit and so a future apply-mode has a flag to gate against.
const dryRun = args.length === 0 || args.includes("--dry-run");
if (!dryRun) {
  process.stderr.write("merger-sweep: only --dry-run is supported in this slice\n");
  process.exit(2);
}

const prs = fetchPRs();
const now = Date.now();
for (const pr of prs) {
  const { action, reason } = decide(pr, now);
  process.stdout.write(JSON.stringify({ pr: pr.number, action, reason }) + "\n");
}
