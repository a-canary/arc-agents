#!/usr/bin/env bun
// Ledger CLI. Flag-only create per PRD-v1 §4; positional args are rejected.
// JSON to stdout when not a TTY; table otherwise.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { open, openWithMigrate, mintId, shortId } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { validateCreate, validateDecompose, validateStateTransition, validateProjectLowerCase, type CreateInput, TIER_VALUES, POOL_VALUES, AGENT_VALUES, type Tier, type Pool, type Agent } from "../src/ledger/bookie-validator";
import { routeProjectFromBody } from "../src/ledger/hygiene-project-route";
import { verifyMergeTruth, defaultRunner } from "../src/ledger/merge-truth";
import { parseDiffReviewPayload, checkReviewerIndependence } from "../src/ledger/diff-review";
import { SORT_KEY_SQL } from "../src/ledger/tier-pool-sort";
import { CLAIM_SQL, buildClaimSQL, claimOnce } from "../src/ledger/claim";
import { CLAIMABLE_KINDS_SQL } from "../src/ledger/kinds";
import { sweepStaleClaims } from "../src/ledger/claim-stale-sweeper";
import { renderSystemPrompt } from "../src/worker/templates";
import { loadThreadContext } from "../src/worker/thread-context";
import { loadConfig, pickModulesForHitl } from "../src/ledger/ux-config";
import { hitlKind, type HitlKind } from "../src/ledger/hitl-schemas";
import { buildPayload, insertHitlPrompt } from "../src/ledger/hitl-prompt";
import { checkDuplicate, type ExistingRow } from "../src/ledger/hygiene-dedup";
import { parseFollowupTable } from "../src/ledger/followup-table";
import { checkInPlaceGuard, checkMergeGuard } from "../src/ledger/merge-guard";
import { loadConfig as loadAppConfig, getAliasCommands } from "../src/config/load";
import { loadProfile } from "../src/profiles/load";
import { encode as toonEncode } from "../src/ledger/toon-encode";
import { brief as directorBrief, type GitLogEntry } from "../src/director/director-brief";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";

const KNOWN_HYGIENE_SKILLS = [
  "clarify-docs",
  "improve-architecture",
  "trash-retired-files",
  "analyse-recent-sessions",
] as const;

const args = process.argv.slice(2);
// Strip a leading --db <path> (or --db=<path>) so bare invocations like
// `ledger --db /path` work — without this, --db is misread as the verb.
let cmd: string | undefined;
{
  let i = 0;
  while (i < args.length && args[i]!.startsWith("--")) {
    const a = args[i]!;
    if (a === "--db" || a.startsWith("--db=")) {
      i += a.includes("=") ? 1 : 2;
      continue;
    }
    break;
  }
  cmd = args[i];
  // ADR-0013 Wave 3: `issue` is a deprecated verb alias, available one
  // release. Resolution is at the SWITCH level (see `case "issue":` below,
  // which falls through to the list body next to the canonical
  // `case "ticket":`). We do NOT rewrite `issue` here, because then a
  // future `case "show":` etc. would also need to be reached under the
  // new name — that requires a sub-command dispatcher, out of scope for
  // Wave 3 (the original `case "issue":` was always bare-list only).
  // Move any pre-verb flags to their original position; getFlag walks
  // process.argv-derived args anyway, so order doesn't matter for flag
  // lookup. No rewrite needed.
}

function out(data: unknown): void {
  if (process.stdout.isTTY && Array.isArray(data)) {
    if (data.length === 0) {
      console.log("(empty)");
      return;
    }
    const rows = data as Record<string, unknown>[];
    const first = rows[0]!;
    const cols = Object.keys(first);
    console.log(cols.join("\t"));
    for (const r of rows) console.log(cols.map((c) => String(r[c] ?? "")).join("\t"));
  } else if (Array.isArray(data) && args.includes("--toon")) {
    // Opt-in token-efficient tabular output for array results.
    // Default non-TTY array output stays JSON — it is the machine-readable
    // contract that cli-invoke.ts (JSON.parse) and the factory depend on.
    console.log(toonEncode(data as Record<string, unknown>[]));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}

// Positional args after the verb, excluding any --flag tokens and their values.
function positionalAfterVerb(): string[] {
  const rest = args.slice(1);
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      if (!a.includes("=")) i++; // skip value
      continue;
    }
    out.push(a);
  }
  return out;
}

switch (cmd) {
  case "init": {
    const db = open(getFlag("db"));
    const ran = migrate(db);
    out({ applied: ran });
    break;
  }

  case "create": {
    // ADR-0013 Wave 3: --kind spec → prd translation (write-side). Mirrors
    // the read-side filter in list/ls above so callers can use the new
    // vocabulary on either verb without tripping the schema constraint.
    const _kindFlag = getFlag("kind");
    const _kindTranslated = _kindFlag === "spec" ? "prd" : _kindFlag;
    // Flag-only. No positional args allowed.
    const input: CreateInput = {
      title: getFlag("title"),
      kind: _kindTranslated,
      type: getFlag("type"),
      body: getFlag("body"),
      acceptance: getFlag("acceptance"),
      parent: getFlag("parent"),
      blockedBy: getFlag("blocked-by"),
      project: getFlag("project"),
      tier: getFlag("tier") ?? getFlag("class"),     // accept both old --class and new --tier
      pool: getFlag("pool") ?? getFlag("urgency"),    // accept both old --urgency and new --pool
    };
    const errs = validateCreate(input, positionalAfterVerb());
    if (errs.length > 0) {
      die(errs.map((e) => `${e.field}: ${e.message}`).join("\n"));
    }
    // Empty/whitespace --project must NOT propagate empty to the row — the factory
  // falls back to arc-agents for empty projects, silently misrouting non-arc-agents
  // work (see analysis-1783934070.md Pattern 3). ?? only substitutes on null/
  // undefined; trim-then-fall-back defends at the bookie layer.
  const project = input.project?.trim() || "arc-agents";
    const kind = input.kind!;
    const type = input.type!;
    const title = input.title!;
    const body = input.body ?? "";
    const acceptance = input.acceptance ?? "";
    const parent = input.parent ?? null;
    const blockedBy = input.blockedBy ?? null;
    const state = blockedBy ? "blocked" : "ready";
    const thread = getFlag("thread") ?? null;
    const sourceModule = getFlag("source-module") ?? null;
    // ADR 0005: pass through when supplied, fall back to schema defaults
    // (tier_unset / pool_unset) so unchanged callers stay compatible.
    const tier = input.tier ?? null;
    const pool = input.pool ?? null;

    const db = openWithMigrate(getFlag("db"));
    const id = mintId(db, title);
    if (tier !== null && pool !== null) {
      db.run(
        `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by, thread_id, source_module, tier, pool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, project, parent, title, body, acceptance, type, state, kind, blockedBy, thread, sourceModule, tier, pool],
      );
    } else if (tier !== null) {
      db.run(
        `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by, thread_id, source_module, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, project, parent, title, body, acceptance, type, state, kind, blockedBy, thread, sourceModule, tier],
      );
    } else if (pool !== null) {
      db.run(
        `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by, thread_id, source_module, pool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, project, parent, title, body, acceptance, type, state, kind, blockedBy, thread, sourceModule, pool],
      );
    } else {
      db.run(
        `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by, thread_id, source_module)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, project, parent, title, body, acceptance, type, state, kind, blockedBy, thread, sourceModule],
      );
    }
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', ?, ?)`,
      [id, getFlag("agent") ?? "cli", title],
    );
    out({ id, state, thread_id: thread });
    break;
  }

  case "claim": {
    // ledger claim <worker> [--pool X] [--type X (deprecated alias)]
    // --pool restricts the claim to a single pool lane (used by fast-pass
    // interactive pool so a reserved slot doesn't burn on backlog work).
    // --type is kept as a deprecated alias for one transition window.
    // SQL lives in src/ledger/claim.ts so the bash bootstrap in
    // worker-shell.sh and this CLI share one canonical UPDATE...RETURNING.
    const worker = args[1] ?? die("worker required");
    if (worker.startsWith("--")) die("worker required (positional)");
    const poolFilter = getFlag("pool") ?? getFlag("type");
    const db = openWithMigrate(getFlag("db"));
    const row = claimOnce(db, worker, poolFilter);
    if (!row) {
      out({ claimed: null });
      break;
    }
    db.run(`INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'claimed', ?, ?)`, [
      row.id,
      worker,
      `claimed by ${worker}`,
    ]);
    out({ claimed: row.id });
    break;
  }

  case "print-claim-sql": {
    // Emit the canonical claim SQL to stdout. Sole consumer is
    // bin/worker-shell.sh, the bash bootstrap (ADR 0001): bash has no
    // agent process yet at claim time, so it can't import claimOnce
    // directly — it pipes this text into sqlite3 instead. Keeping the
    // SQL in one place preserves G-0002's single-statement guarantee.
    //
    // `--pool-filter` emits the variant with `AND pool=?2` baked in, so
    // bash callers don't have to rewrite the SQL post-hoc.
    // `--type-filter` is kept as a deprecated alias.
    const withPoolFilter = args.includes("--pool-filter") || args.includes("--type-filter");
    process.stdout.write(withPoolFilter ? buildClaimSQL(true) : CLAIM_SQL);
    break;
  }

  case "decompose": {
    // ledger decompose <parent-id> --child "t1" --child "t2" ...
    // Each --child value may be a bare title string (inherits parent tier+pool,
    // agent='agent_unset') OR a JSON object
    // {"title":..., "body"?:..., "project"?:..., "tier"?:..., "pool"?:..., "agent"?:...}.
    // No top-level --title/--body/--project flags exist (unlike `create`); passing them
    // hard-errors instead of being silently dropped (improve-architecture-ledger-decompose-ch).
    // Atomic: insert N HITL children, set parent.blocked_by=[ids], parent.state='blocked'.

    type ChildSpec = { title: string; body?: string; project?: string; tier?: Tier; pool?: Pool; agent?: Agent };
    const CHILD_SPEC_KEYS = ["title", "body", "project", "tier", "pool", "agent"];

    const parent = args[1];
    if (!parent || parent.startsWith("--")) die("parent id required (positional)");

    const rawChildren: string[] = [];
    for (let i = 2; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--child") {
        const v = args[++i];
        if (v !== undefined) rawChildren.push(v);
      } else if (a.startsWith("--child=")) {
        rawChildren.push(a.slice("--child=".length));
      } else if (a === "--title" || a === "--body" || a === "--project" || a.startsWith("--title=") || a.startsWith("--body=") || a.startsWith("--project=")) {
        // decompose has no per-call --title/--body/--project flags (create does).
        // Silently ignoring these produced garbage children (see improve-architecture-ledger-decompose-ch).
        die(`decompose does not accept top-level --title/--body/--project. Pass a --child JSON object instead: --child '{"title":"...","body":"...","project":"..."}'`);
      }
    }

    // Parse and validate each child spec before touching the DB (fail fast).
    const childSpecs: ChildSpec[] = [];
    for (const v of rawChildren) {
      if (v.trim().startsWith("{")) {
        // JSON child spec
        let parsed: unknown;
        try {
          parsed = JSON.parse(v);
        } catch {
          die(`--child: invalid JSON: ${v}`);
        }
        const obj = parsed as Record<string, unknown>;
        if (!obj.title || typeof obj.title !== "string") {
          die(`--child JSON must include a "title" string field`);
        }
        const unknownKeys = Object.keys(obj).filter((k) => !CHILD_SPEC_KEYS.includes(k));
        if (unknownKeys.length > 0) {
          die(`--child JSON has unrecognized field(s): ${unknownKeys.join(", ")}. Supported: ${CHILD_SPEC_KEYS.join(", ")}`);
        }
        const spec: ChildSpec = { title: obj.title as string };
        if (obj.body !== undefined) {
          if (typeof obj.body !== "string") die(`--child: "body" must be a string`);
          spec.body = obj.body;
        }
        if (obj.project !== undefined) {
          if (typeof obj.project !== "string") die(`--child: "project" must be a string`);
          spec.project = obj.project;
        }
        if (obj.tier !== undefined) {
          if (!TIER_VALUES.includes(obj.tier as Tier)) {
            die(`--child: invalid tier '${obj.tier}' — must be one of: ${TIER_VALUES.join(", ")}`);
          }
          spec.tier = obj.tier as Tier;
        }
        if (obj.pool !== undefined) {
          if (!POOL_VALUES.includes(obj.pool as Pool)) {
            die(`--child: invalid pool '${obj.pool}' — must be one of: ${POOL_VALUES.join(", ")}`);
          }
          spec.pool = obj.pool as Pool;
        }
        if (obj.agent !== undefined) {
          if (!AGENT_VALUES.includes(obj.agent as Agent)) {
            die(`--child: invalid agent '${obj.agent}' — must be one of: ${AGENT_VALUES.join(", ")}`);
          }
          spec.agent = obj.agent as Agent;
        }
        childSpecs.push(spec);
      } else {
        // Bare title string — inherit tier+pool from parent, agent defaults to agent_unset.
        childSpecs.push({ title: v });
      }
    }

    // validateDecompose checks fanout cap and empty titles.
    const errs = validateDecompose({ parent, children: childSpecs.map((s) => s.title) });
    if (errs.length > 0) die(errs.map((e) => `${e.field}: ${e.message}`).join("\n"));

    const db = openWithMigrate(getFlag("db"));
    const parentRow = db.query<{ id: string; project: string; state: string; tier: string; pool: string }, [string]>(
      "SELECT id, project, state, tier, pool FROM issues WHERE id=?",
    ).get(parent);
    if (!parentRow) die(`no such issue: ${parent}`);
    if (parentRow.state === "merged" || parentRow.state === "cancelled") {
      die(`cannot decompose from terminal state '${parentRow.state}'`);
    }
    const agent = getFlag("agent") ?? "bookie";
    const created: { id: string; title: string }[] = [];
    db.exec("BEGIN");
    try {
      for (const spec of childSpecs) {
        const id = mintId(db, spec.title);
        // ADR 0005: unset fields inherit parent's tier+pool so a prod/interactive
        // decomposition stays prod/interactive instead of dumping the subtree
        // into the tier_unset triage backlog. agent defaults to agent_unset.
        const childTier = spec.tier ?? parentRow.tier;
        const childPool = spec.pool ?? parentRow.pool;
        const childAgent = spec.agent ?? "agent_unset";
        const childProject = spec.project ?? parentRow.project;
        const childBody = spec.body ?? "";
        db.run(
          `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by, tier, pool, agent)
           VALUES (?, ?, ?, ?, ?, '', 'HITL', 'ready', 'task', NULL, ?, ?, ?)`,
          [id, childProject, parent, spec.title, childBody, childTier, childPool, childAgent],
        );
        db.run(
          `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', ?, ?)`,
          [id, agent, `decomposed from ${parent}: ${spec.title}`],
        );
        created.push({ id, title: spec.title });
      }
      const blockedBy = JSON.stringify(created.map((c) => c.id));
      db.run(
        `UPDATE issues SET state='blocked', blocked_by=?, claimed_by=NULL, claimed_at=NULL, updated_at=strftime('%s','now') WHERE id=?`,
        [blockedBy, parent],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'progress', ?, ?)`,
        [parent, agent, `decomposed into ${created.length} children: ${created.map((c) => c.id).join(", ")}`],
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    out({ parent, children: created });
    break;
  }

  case "update": {
    const id = args[1] ?? die("id required");
    const state = getFlag("state");
    const evidence = getFlag("evidence");
    const pr = getFlag("pr");
    const localSha = getFlag("local-merged-sha");
    // --in-place is the third (explicit-assertion) merge-truth route. The CLI
    // refuses to set both --in-place and --pr, so workers can no longer sneak
    // a branch-shaped string through the PR route as an "in-place with no PR"
    // acknowledgement. --in-place skips verifyMergeTruth's PR/sha checks; the
    // worker's --evidence is the receipt. See bookie.md rule 2.
    const inPlace = args.includes("--in-place");
    if (inPlace && pr) {
      die("--in-place is mutually exclusive with --pr. Use --in-place alone (with --evidence) for in-place merges, --pr to verify a PR, or --local-merged-sha to verify a sha.");
    }
    // Ponytail: in-place merges are the ghost-merge attack surface (analysis-1781194129
    // Pattern 1 / analysis-1780502957 Pattern 4). Require --evidence so the worker
    // explains the no-PR situation. If the row has a worktree_path, also verify the
    // worktree still exists on disk — a deleted worktree is strong signal the
    // worker fabricated the merge.
    if (inPlace && !evidence) {
      die("--in-place requires --evidence <note> explaining why no git artifact (\u2264280 chars). Absent evidence, a ghost merge cannot be distinguished from a real one.");
    }
    if (inPlace && evidence && evidence.length > 280) {
      die(`--evidence for --in-place must be \u2264280 chars (got ${evidence.length}). Concise evidence is intentional \u2014 long justifications are a ghost-merge smell.`);
    }
    // --no-diff: hygiene/analysis skills legitimately terminate with zero diff
    // (nothing to trash, N<3 sample, fix already landed upstream). Without this,
    // workers overload state=failed for correct negative results, losing signal
    // for stats/sweeper heuristics. --no-diff skips the diff_review requirement
    // in exchange for mandatory --evidence naming the negative result; it does
    // NOT skip verifyMergeTruth (a --no-diff merge still needs --pr/--local-merged-sha/
    // --in-place like any other merge).
    const noDiff = args.includes("--no-diff");
    if (noDiff && !evidence) {
      die("--no-diff requires --evidence <note> explaining the negative result (no diff to review).");
    }
    const branch = getFlag("branch");
    const worktree = getFlag("worktree");
    const hitl = getFlag("hitl");
    // --blocked-by is intentionally NOT honoured on `update` — silent drops
    // masked real decomposition attempts as successful no-ops. The
    // purpose-built `decompose` verb wires parent.blocked_by + parent.state
    // atomically alongside child inserts; use that for fan-out.
    // Known gap: no correction path for a stale blocked_by on a row not
    // created via decompose. See CHOICES.md I-0010.
    if (args.includes("--blocked-by")) {
      die("--blocked-by is set by the `decompose` verb, not `update`. Use `ledger decompose <parent> --child \"<title>\"` to wire parent.blocked_by + parent.state=blocked atomically.");
    }
    const db = openWithMigrate(getFlag("db"));

    // in-place worktree existence check: must run after db is available.
    if (inPlace) {
      // Fetch worktree_path from the row; a missing worktree dir on in-place merge
      // is a strong ghost-merge signal (worker deleted the evidence before claiming
      // the merge). Only check when worktree_path is set (some rows have no worktree).
      const rowWorktree = db
        .query<{ worktree_path: string | null }, [string]>(
          "SELECT worktree_path FROM issues WHERE id=?",
        )
        .get(id)?.worktree_path;
      if (rowWorktree) {
        const { existsSync } = require("node:fs") as typeof import("node:fs");
        if (!existsSync(rowWorktree)) {
          die(
            `--in-place refused: worktree '${rowWorktree}' no longer exists on disk. A deleted worktree before in-place merge is a ghost-merge signal \u2014 supply --pr or --local-merged-sha instead.`,
          );
        }
      }
    }

    if (state) {
      const cur = db.query<{ state: string; pr_url: string | null }, [string]>(
        "SELECT state, pr_url FROM issues WHERE id=?",
      ).get(id);
      if (!cur) die(`no such issue: ${id}`);
      const errs = validateStateTransition(cur.state as never, state as never);
      if (errs.length > 0) die(errs.map((e) => `${e.field}: ${e.message}`).join("\n"));
      // Fetch the row's project once when we're headed toward state=merged
      // — used by both the merge-guard (checkMergeGuard) and the runner
      // factory (defaultRunner). Hoisting it here avoids a second SQL
      // round-trip and makes the project-pinning to defaultRunner obvious.
      const project = state === "merged"
        ? db.query<{ project: string }, [string]>("SELECT project FROM issues WHERE id=?").get(id)?.project
        : undefined;
      if (state === "merged" && !noDiff) {
        // diff_review payload contract: require the LATEST diff_review event
        // to parse as JSON {reviewer_identity, reviewed_sha, verdict}, and
        // the reviewer_identity must not match the row's claimed_by. This
        // replaces the legacy "is there any diff_review event at all" check
        // (analysis-1780502957 Pattern 1 Part A: worker self-review).
        const latestReview = db
          .query<{ payload_md: string | null; agent: string | null }, [string]>(
            `SELECT payload_md, agent FROM issue_events
             WHERE issue_id=? AND kind='diff_review'
             ORDER BY seq DESC LIMIT 1`,
          )
          .get(id);
        if (!latestReview) {
          die(
            `refuse merged: no diff_review event for ${id}. Run /diff-review skill, then log via 'ledger event ${id} diff_review <json>' before merging. If this row has no diff to review, use --no-diff --evidence "<why>" instead.`,
          );
        }
        const reviewParse = parseDiffReviewPayload(latestReview.payload_md);
        if (!reviewParse.ok) {
          die(`refuse merged: ${reviewParse.reason}`);
        }
        const claimedBy = db
          .query<{ claimed_by: string | null }, [string]>("SELECT claimed_by FROM issues WHERE id=?")
          .get(id)?.claimed_by;
        const indepMsg = checkReviewerIndependence(reviewParse.payload.reviewer_identity, claimedBy);
        if (indepMsg) die(indepMsg);
      }
      if (state === "merged") {
        // analysis-1780502957 Pattern 1 Part A: enforce pr_url's repo matches
        // the row's project field. The guard runs at the bookie layer so
        // a worker cannot mark a row merged against the wrong github repo.
        // Applies regardless of --no-diff — a no-diff merge with a PR still
        // must point at the right repo.
        const guardMsg = checkMergeGuard(project, pr);
        if (guardMsg) die(guardMsg);
        // analysis-1784455208 Pattern 1: --in-place on a non-owned public
        // repo asserts a merge the worker cannot have performed (only the
        // operator merges there). Refuse unless --force-in-place.
        const inPlaceMsg = checkInPlaceGuard(project, inPlace, args.includes("--force-in-place"));
        if (inPlaceMsg) die(inPlaceMsg);
      }
      if (state === "merged" && process.env.ARC_SKIP_MERGE_TRUTH !== "1") {
        // --in-place overrides any stale pr_url on the row (the worker is
        // asserting, not citing a PR). For all other paths, --pr wins over
        // the row's stored pr_url; the row's pr_url is the fallback when no
        // --pr is supplied this invocation.
        const effectivePr = inPlace ? null : (pr ?? cur.pr_url ?? null);
        // Pass the row's project through so defaultRunner pins the git/gh
        // child to ~/repos/<repoDir>. Without this, a worker/cron running
        // from a non-repo cwd (e.g. ~/trash/<ts>/, a reaped worktree) fires
        // the merge-guard from a directory that isn't a git repo, git
        // exits 128, and the operator sees an empty trailing-colon
        // refusal message (analysis-1783937189 Pattern 1).
        const verdict = await verifyMergeTruth({ prUrl: effectivePr, localSha, inPlace, run: defaultRunner(project) });
        if (!verdict.ok) {
          db.run(
            `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, ?, ?, ?)`,
            [id, "note", getFlag("agent") ?? "cli", `refused state=merged: ${verdict.reason}`],
          );
          die(`refused: ${verdict.reason}`);
        }
      }
    }

    const sets: string[] = ["updated_at=strftime('%s','now')"];
    const vals: (string | number)[] = [];
    if (state) {
      sets.push("state=?");
      vals.push(state);
      // Symmetric with claim-stale-sweeper: any transition to a non-claimed
      // state must clear claim fields so dashboards/queries don't see stale
      // claimed_by on a blocked or failed row.
      if (state === "blocked" || state === "ready" || state === "failed" || state === "cancelled") {
        sets.push("claimed_by=NULL");
        sets.push("claimed_at=NULL");
      }
      // 021: gate worktree reaper on hygiene phase. Merged rows are reaped only
      // after hygiene_complete=1 (set by hygiene-emit). Default 0 on merge.
      if (state === "merged") {
        sets.push("hygiene_complete=0");
      }
    }
    if (evidence) {
      sets.push("evidence_md=?");
      vals.push(evidence);
    }
    if (pr) {
      sets.push("pr_url=?");
      vals.push(pr);
    }
    if (branch) {
      sets.push("branch=?");
      vals.push(branch);
    }
    if (worktree) {
      sets.push("worktree_path=?");
      vals.push(worktree);
    }
    if (hitl !== undefined) {
      if (hitl !== "0" && hitl !== "1") die("--hitl must be 0 or 1");
      sets.push("hitl=?");
      vals.push(Number(hitl));
    }
    const agentFlag = getFlag("agent-set") ?? (state ? undefined : getFlag("agent"));
    if (agentFlag !== undefined) {
      sets.push("agent=?");
      vals.push(agentFlag);
    }
    const projectFlag = getFlag("project");
    if (projectFlag !== undefined) {
      const projectErrs = validateProjectLowerCase(projectFlag);
      if (projectErrs.length > 0) die(projectErrs.map((e) => `${e.field}: ${e.message}`).join("\n"));
      sets.push("project=?");
      vals.push(projectFlag);
    }
    vals.push(id);
    db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id=?`, vals);
    if (state) {
      // [no-diff] prefix lets stats/sweeper heuristics (claim-stale-sweeper
      // cooldown, hygiene dashboards) distinguish a correct negative result
      // from a real code-shipping merge without a schema change.
      const payload = evidence ? `→ ${state}\n\n${evidence}` : `→ ${state}`;
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, ?, ?, ?)`,
        [id, state === "merged" ? "merged" : state === "failed" ? "failed" : "progress", getFlag("agent") ?? "cli", noDiff ? `[no-diff] ${payload}` : payload],
      );
    }
    out({ id, updated: true });
    break;
  }

  case "repoint-blocked-by": {
    // Repoint an existing blocked row's blocked_by to different sibling
    // id(s), e.g. when the stated blocker resolves but the real prerequisite
    // is a sibling created in the same decomposition. Row must already be
    // state=blocked (use `decompose` to create+block atomically instead).
    const id = args[1] ?? die("id required");
    const rest = args.slice(2);
    const flagStart = rest.findIndex((a) => a.startsWith("--"));
    const newBlockers = flagStart === -1 ? rest : rest.slice(0, flagStart);
    if (newBlockers.length === 0) die("at least one blocker id required: ledger repoint-blocked-by <id> <blockerId> [blockerId...]");
    const db = openWithMigrate(getFlag("db"));
    const cur = db.query<{ state: string; blocked_by: string | null }, [string]>(
      "SELECT state, blocked_by FROM issues WHERE id=?",
    ).get(id);
    if (!cur) die(`no such issue: ${id}`);
    if (cur.state !== "blocked") die(`refuse repoint-blocked-by: ${id} is state=${cur.state}, not blocked`);
    if (newBlockers.includes(id)) die(`refuse repoint-blocked-by: ${id} cannot block itself`);
    for (const b of newBlockers) {
      const blocker = db.query<{ state: string }, [string]>("SELECT state FROM issues WHERE id=?").get(b);
      if (!blocker) die(`no such issue (blocker): ${b}`);
      // A blocker already in a terminal state would cascade-unblock this row
      // on the very next `tick` sweep, defeating the point of repointing
      // (avoiding premature wake per the discovering task's brief).
      if (blocker.state === "merged" || blocker.state === "cancelled") {
        die(`refuse repoint-blocked-by: blocker ${b} is already state=${blocker.state}; repointing to it would immediately cascade-unblock ${id} on the next tick`);
      }
    }
    const blockedBy = JSON.stringify(newBlockers);
    db.run(
      `UPDATE issues SET blocked_by=?, updated_at=strftime('%s','now') WHERE id=?`,
      [blockedBy, id],
    );
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'progress', ?, ?)`,
      [id, getFlag("agent") ?? "cli", `repointed blocked_by: ${cur.blocked_by ?? "null"} -> ${blockedBy}`],
    );
    out({ id, blocked_by: newBlockers, repointed: true });
    break;
  }

  case "event": {
    const id = args[1] ?? die("id required");
    const kind = args[2] ?? die("kind required");
    const payload = args[3] ?? "";
    const db = openWithMigrate(getFlag("db"));
    db.run(`INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, ?, ?, ?)`, [
      id,
      kind,
      getFlag("agent") ?? "cli",
      payload,
    ]);
    out({ id, kind, logged: true });
    break;
  }

  case "feedback": {
    // Trust-tiered friction/feedback intake (PRD self-guided-portal §Feedback).
    // Flag-only. --source defaults to ai-agent (agents reporting friction outside
    // their task); --context anchors it to a page/topic; --task links an origin issue.
    const source = getFlag("source") ?? "ai-agent";
    const project = getFlag("project") ?? die("--project required");
    const projectErrs = validateProjectLowerCase(project);
    if (projectErrs.length > 0) die(projectErrs.map((e) => `${e.field}: ${e.message}`).join("\n"));
    const body = getFlag("body") ?? die("--body required");
    const id = `fb-${shortId()}`;
    const db = openWithMigrate(getFlag("db"));
    db.run(
      `INSERT INTO feedback (id, project, source, body_md, context, origin_task_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, project, source, body, getFlag("context") ?? null, getFlag("task") ?? null],
    );
    out({ id, source, project, logged: true });
    break;
  }

  // ADR-0013 Wave 3: `issue` is a deprecated verb alias for the list body
  // (was always bare-list only); `ticket` is the canonical replacement.
  // Both fall through here for one release; `issue` emits a stderr hint.
  case "issue":
  case "ticket":
  case "ls":
  case "list": {
    if (cmd === "issue" && process.stderr.isTTY) {
      process.stderr.write(
        "warning: `ledger issue` is deprecated; use `ledger ticket` (ADR-0013)\n",
      );
    }
    const state = getFlag("state");
    // ADR-0013 Wave 3: accept `--kind spec` as canonical alias for the legacy `prd`.
    // The schema still stores `prd` (Wave 4 will move to `kind=spec, type=prd`).
    const kindRaw = getFlag("kind");
    const kind = kindRaw === "spec" ? "prd" : kindRaw;
    const type = getFlag("type");
    const createdBy = getFlag("created-by");
    const all = args.includes("--all");
    const limit = parseInt(getFlag("limit") ?? "100", 10);
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (state) {
      where.push("state=?");
      vals.push(state);
    } else if (!all) {
      where.push("state NOT IN ('merged','cancelled','failed')");
    }
    if (kind) {
      where.push("kind=?");
      vals.push(kind);
    }
    if (type) {
      where.push("type=?");
      vals.push(type);
    }
    if (createdBy) {
      where.push(
        "id IN (SELECT issue_id FROM issue_events WHERE kind='created' AND agent=?)",
      );
      vals.push(createdBy);
    }
    const sql = `SELECT id, state, kind, type, title FROM issues ${
      where.length ? "WHERE " + where.join(" AND ") : ""
    } ORDER BY ${SORT_KEY_SQL} LIMIT ?`;
    vals.push(limit);
    const db = openWithMigrate(getFlag("db"));
    const rows = db.query(sql).all(...vals) as Record<string, unknown>[];
    out(rows);
    if (process.stderr.isTTY) {
      const hint = state
        ? `Next: \`ledger show <id>\` to inspect, or \`ledger claim <id>\` to start.`
        : `Next: \`ledger list --state ready\` for the queue, or \`ledger show <id>\` to inspect.`;
      process.stderr.write(hint + "\n");
    }
    break;
  }

  case "show": {
    const id = args[1] ?? die("id required");
    const db = openWithMigrate(getFlag("db"));
    const issue = db.query("SELECT * FROM issues WHERE id=?").get(id);
    if (!issue) die(`no such issue: ${id}`);
    const events = db.query("SELECT seq, ts, agent, kind, payload_md FROM issue_events WHERE issue_id=? ORDER BY seq").all(id);
    // ADR-0013 Wave 3: dual-key emission — `ticket` is canonical, `issue` is deprecated alias.
    out({ ticket: issue, issue, events });
    if (process.stderr.isTTY) {
      const st = (issue as { state: string }).state;
      const hint = st === "ready"
        ? `Next: \`ledger claim ${id}\` to start work.`
        : st === "wip" || st === "claimed" || st === "review"
        ? `Next: \`ledger update ${id} --state merged --evidence ...\` to close (with --pr or --local-merged-sha), or \`--in-place\` for in-place closure.`
        : `Next: state=${st}; no default verb.`;
      process.stderr.write(hint + "\n");
    }
    break;
  }

  case "hitl": {
    // hitl emit --class taste|impact --kind ask_choice|ask_text|ask_confirm|notify|show_artifact
    //          --prompt "<q>" [--option X --option Y ...] [--recommended <idx-or-string>]
    //          [--timeout-sec N] [--divergence forward_fix|replay]
    //          [--anchor-repo R --anchor-branch B --anchor-commit C]
    //          [--emitted-by <id>] [--agent bookie]
    // Inserts hitl_prompts row + fans out hitl_deliveries to alive modules
    // implementing this kind. Returns { id, deliveries }. MVP for taste-class
    // optimistic execution: worker emits, surfaces to user, proceeds with
    // recommended; reconciliation handled separately.
    const sub = args[1];
    if (sub !== "emit") die("usage: hitl emit ...");
    const cls = getFlag("class") ?? die("--class taste|impact required");
    if (cls !== "taste" && cls !== "impact") die("--class must be taste|impact");
    const kindRaw = getFlag("kind") ?? die("--kind required");
    // Validate enum membership early — keeps the per-verb error consistent
    // with the prior CLI behavior rather than letting buildPayload's exhaustive
    // switch throw a less-helpful generic error.
    const kindParsed = hitlKind.safeParse(kindRaw);
    if (!kindParsed.success) {
      die(`--kind '${kindRaw}' not supported by this verb (use ${hitlKind.options.join("|")})`);
    }
    const kind: HitlKind = kindParsed.data;
    const promptText = getFlag("prompt") ?? die("--prompt required");
    const recommended = getFlag("recommended");
    const timeoutSec = getFlag("timeout-sec");
    const divergence = getFlag("divergence");
    const anchorRepo = getFlag("anchor-repo");
    const anchorBranch = getFlag("anchor-branch");
    const anchorCommit = getFlag("anchor-commit");
    const emittedBy = getFlag("emitted-by") ?? getFlag("agent") ?? "bookie";

    if (cls === "taste" && recommended === undefined)
      die("--recommended required for class=taste");
    if (cls === "impact" && timeoutSec !== undefined)
      die("--timeout-sec forbidden for class=impact");
    if (divergence && divergence !== "forward_fix" && divergence !== "replay")
      die("--divergence must be forward_fix|replay");

    // Repeatable --option flag → options[] for ask_choice.
    const options: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--option") {
        const v = args[i + 1];
        if (v !== undefined) options.push(v);
      } else if (args[i]?.startsWith("--option=")) {
        options.push(args[i]!.slice("--option=".length));
      }
    }

    // Build + validate the payload via the consolidated module so the Zod
    // checks (e.g. ask_choice requires options.min(2)) actually run. Pre-
    // refactor this code path inserted directly without validation.
    let validatedPayload: unknown;
    try {
      validatedPayload = buildPayload(kind, {
        prompt: promptText,
        options,
        message: promptText,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      die(`payload validation failed for kind=${kind}: ${msg}`);
    }

    const db = openWithMigrate(getFlag("db"));
    const cfg = loadConfig();
    const timeoutSecInt = timeoutSec ? parseInt(timeoutSec, 10) : null;

    let result: { id: string; deliveries: string[] };
    try {
      result = insertHitlPrompt(db, {
        kind,
        cls,
        payload: validatedPayload,
        recommended: recommended ?? null,
        strategy: (divergence as "forward_fix" | "replay" | undefined) ?? null,
        timeoutSec: timeoutSecInt,
        anchor:
          anchorRepo || anchorBranch || anchorCommit
            ? { repo: anchorRepo ?? null, branch: anchorBranch ?? null, commit: anchorCommit ?? null }
            : null,
        emittedBy,
        cfg,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("no alive UX module")) {
        die(`no alive UX module implements '${kind}' — install/revive one (ADR 0002)`);
      }
      die(msg);
    }
    out({
      id: result.id,
      kind,
      class: cls,
      recommended: recommended ?? null,
      deliveries: result.deliveries,
    });
    break;
  }

  case "hygiene-emit": {
    // hygiene-emit --skill <s> --title <t> [--body <b>] [--observed-in-task <id>] [--agent bookie]
    // Inserts class=hygiene kind=task type=quality state=ready row with title
    // prefixed "<skill>: <title>". Dedups against ready/blocked/wip/claimed
    // hygiene rows with same skill + similar title (Levenshtein / substring).
    // Hard CLI guarantee — workers can fire without re-implementing dedup.
    const skill = getFlag("skill");
    const title = getFlag("title");
    const body = getFlag("body") ?? "";
    const observed = getFlag("observed-in-task") ?? null;
    const explicitProject = getFlag("project");
    const agent = getFlag("agent") ?? "cli";
    if (!skill) die("--skill required (one of: " + KNOWN_HYGIENE_SKILLS.join(", ") + ")");
    if (!KNOWN_HYGIENE_SKILLS.includes(skill as (typeof KNOWN_HYGIENE_SKILLS)[number])) {
      die(`--skill must be one of: ${KNOWN_HYGIENE_SKILLS.join(", ")}`);
    }
    if (!title || title.startsWith("--")) die("--title required");
    const projectErrs = validateProjectLowerCase(getFlag("project"));
    if (projectErrs.length > 0) die(projectErrs.map((e) => `${e.field}: ${e.message}`).join("\n"));

    const db = openWithMigrate(getFlag("db"));
    // Resolve project, in precedence order:
    //   1. explicit --project (worker knows best)
    //   2. file-path routing — if --body names a shared-source file
    //      (bin/ledger.ts, src/ledger/*, …) it can only live in that file's
    //      home repo, regardless of which task observed it. Beats observed-
    //      task inheritance because the fix physically must land there
    //      (improve-architecture-route-hygiene-emit-: arc-skills task, fix in
    //      arc-agents src → row must be project=arc-agents or bookie's merge
    //      guard refuses the PR as a repo mismatch).
    //   3. inherit --observed-in-task row's project (the worker is filing a
    //      followup for that specific task).
    //   4. default 'arc-agents'.
    // The cron caller (bin/hygiene-tick.ts) does not go through hygiene-emit
    // (it inserts directly with the repo name), so this only affects
    // worker-emitted followups.
    let project = explicitProject;
    if (!project) project = routeProjectFromBody(body) ?? undefined;
    if (!project && observed) {
      const observedRow = db
        .query<{ project: string }, [string]>(`SELECT project FROM issues WHERE id=?`)
        .get(observed);
      if (observedRow?.project) project = observedRow.project;
    }
    if (!project) project = "arc-agents";
    const existing = db
      .query<ExistingRow, []>(
        `SELECT id, title, tier, state, NULL AS skill
         FROM issues
         WHERE tier='hygiene'
           AND state IN ('ready','blocked','wip','claimed')`,
      )
      .all();
    const verdict = checkDuplicate(skill, title, existing);
    if (verdict.duplicate) {
      out({
        emitted: false,
        duplicate_of: verdict.existingId,
        reason: verdict.reason,
      });
      break;
    }

    const prefixedTitle = title.startsWith(`${skill}:`) ? title : `${skill}: ${title}`;
    const observedNote = observed ? `\n\nObserved in task: ${observed}` : "";
    const finalBody = body + observedNote;
    const id = mintId(db, prefixedTitle);
    db.run(
      `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, tier)
       VALUES (?, ?, NULL, ?, ?, '', 'quality', 'ready', 'task', 'hygiene')`,
      [id, project, prefixedTitle, finalBody],
    );
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', ?, ?)`,
      [id, agent, `hygiene-emit skill=${skill}${observed ? ` observed_in=${observed}` : ""}`],
    );
    // 021: flip hygiene_complete=1 on the parent task so the worktree reaper
    // can proceed. Only applies when --observed-in-task is provided (workers
    // use it to tag the task that triggered the hygiene observation).
    if (observed) {
      db.run(
        `UPDATE issues SET hygiene_complete=1, updated_at=strftime('%s','now') WHERE id=? AND hygiene_complete=0`,
        [observed],
      );
    }

    out({ id, emitted: true, skill, state: "ready", tier: "hygiene" });
    break;
  }

  case "followup-emit": {
    // Parses the analyse-recent-sessions report's "Recommended follow-up
    // rows to file" markdown table and emits one row per entry, tier=quality
    // kind=task state=ready. The analyse-recent-sessions skill's Termination
    // section requires workers to call this verb before flipping state=merged.
    const ap = getFlag("analysis");
    if (!ap) die("--analysis <md-path> required");
    let md: string;
    try { md = readFileSync(ap, "utf8"); } catch (e) { die(`cannot read --analysis ${ap}: ${(e as Error).message}`); }
    const rows = parseFollowupTable(md);
    if (rows.length === 0) die(`no follow-up table parsed from ${ap}`);
    const db = openWithMigrate(getFlag("db"));
    const observed = getFlag("observed-in-task");
    const agent = getFlag("agent") ?? "bookie";
    // Empty/whitespace --project must NOT propagate empty to the followup rows
    // (same trap as create + plan + chat-reply — analysis-1783934070.md Pattern 3).
    const project = getFlag("project")?.trim() || "arc-agents";
    const projectErrs = validateProjectLowerCase(project);
    if (projectErrs.length > 0) die(projectErrs.map((e) => `${e.field}: ${e.message}`).join("\n"));
    const created: { id: string; title: string; type: string }[] = [];
    for (const r of rows) {
      const id = mintId(db, r.title);
      const body = r.body + (observed ? `\n\nObserved in task: ${observed}\nSource: ${ap}` : `\n\nSource: ${ap}`);
      db.run(
        `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, tier, pool, agent) VALUES (?, ?, NULL, ?, ?, '', ?, 'ready', 'task', 'quality', 'ops', 'developer')`,
        [id, project, r.title, body, r.type],
      );
      db.run(`INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', ?, ?)`, [id, agent, `followup-emit from ${ap}`]);
      created.push({ id, title: r.title, type: r.type });
    }
    out({ emitted: created.length, rows: created });
    break;
  }

  case "tick": {
    // Backstop sweep: cascade-unblock + reclaim stale claims (>2hr)
    // + reap expired hitl_prompts (open → timeout_locked).
    //
    // Two-arm unblock mirrors migration 019's trigger pair (change #4):
    //   Arm 1 (non-sprint): re-readies when ALL blockers are merged. Strict.
    //   Arm 2 (sprint): re-readies when ALL blockers are terminal
    //                   (merged|failed|cancelled).
    const db = openWithMigrate(getFlag("db"));
    const u1 = db.run(`
      UPDATE issues SET state='ready', updated_at=strftime('%s','now')
      WHERE state='blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'
        AND kind != 'sprint'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(issues.blocked_by) dep
          JOIN issues b ON b.id = dep.value
          WHERE b.state != 'merged'
        )
    `);
    const u2 = db.run(`
      UPDATE issues SET state='ready', updated_at=strftime('%s','now')
      WHERE state='blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'
        AND kind = 'sprint'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(issues.blocked_by) dep
          JOIN issues b ON b.id = dep.value
          WHERE b.state NOT IN ('merged','failed','cancelled')
        )
    `);
    const u = { changes: u1.changes + u2.changes };
    const s = sweepStaleClaims(db);
    // Collect ids first so we can return them; the UPDATE itself fires
    // hitl_retract_losers (migrate.ts:284) which retracts pending/delivered
    // sibling deliveries — that's exactly the cascade we want.
    const expiredRows = db
      .query<{ id: string }, []>(
        `SELECT id FROM hitl_prompts
         WHERE state='open' AND expires_at IS NOT NULL
           AND expires_at <= strftime('%s','now')`,
      )
      .all();
    const expiredIds = expiredRows.map((r) => r.id);
    if (expiredIds.length > 0) {
      db.run(
        `UPDATE hitl_prompts SET state='timeout_locked'
         WHERE state='open' AND expires_at IS NOT NULL
           AND expires_at <= strftime('%s','now')`,
      );
    }
    out({
      unblocked: u.changes,
      reclaimed: s.reset,
      reclaimed_ids: s.ids,
      expired: expiredIds.length,
      expired_ids: expiredIds,
    });
    break;
  }

  case "trash-sweep": {
    // Delegate to bin/trash-sweep.ts. Forward --apply and --dir. Output is
    // JSON; we surface it directly so cron can pipe the summary into logs.
    // The script writes to stdout and the verb just relays.
    const here = process.argv[1]!;
    let scriptDir: string;
    try {
      scriptDir = dirname(realpathSync(here));
    } catch {
      scriptDir = dirname(here);
    }
    const scriptArgs: string[] = [join(scriptDir, "trash-sweep.ts")];
    if (args.includes("--apply")) scriptArgs.push("--apply");
    const dirFlag = getFlag("dir") ?? process.env.TRASH_DIR;
    if (dirFlag) scriptArgs.push("--dir", dirFlag);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (dirFlag) env.TRASH_DIR = dirFlag;
    const proc = Bun.spawnSync(["bun", ...scriptArgs], { env, stdout: "pipe", stderr: "pipe" });
    if (proc.stdout.length > 0) process.stdout.write(proc.stdout);
    if (proc.stderr.length > 0) process.stderr.write(proc.stderr);
    process.exit(proc.exitCode);
  }

  case "spawn-ready": {
    // --pool X: filter by pool column (preferred). --type X: deprecated alias.
    const pool = getFlag("pool") ?? getFlag("type");
    const db = openWithMigrate(getFlag("db"));
    const sql = `SELECT id, kind, type, title FROM issues WHERE state='ready' AND kind IN (${CLAIMABLE_KINDS_SQL}) ${
      pool ? "AND pool=?" : ""
    } ORDER BY ${SORT_KEY_SQL}`;
    out(pool ? db.query(sql).all(pool) : db.query(sql).all());
    break;
  }

  case "render-prompt": {
    // Emit the rendered worker system prompt for <id>. Pure read; no side effects.
    // worker-shell.sh shells out to this after claim so prompt logic lives in TS.
    const id = args[1] ?? die("id required");
    const worker = getFlag("worker") ?? "unknown";
    const db = openWithMigrate(getFlag("db"));
    const row = db
      .query<{ kind: string; agent: string; pool: string; thread_id: string | null; state: string; evidence_md: string | null }, [string]>(
        `SELECT kind, agent, pool, thread_id, state, evidence_md FROM issues WHERE id=?`,
      )
      .get(id);
    if (!row) die(`no issue ${id}`);
    // Handoff resume: a non-terminal row that already carries evidence_md was
    // worked before (worker died/blocked and left a handoff via /handoff or
    // `update --evidence`). Surface it so the re-claiming worker continues
    // instead of restarting. Terminal rows shouldn't be re-rendered, but guard
    // anyway so a stale merged/cancelled row never leaks evidence into a prompt.
    const handoff =
      row.evidence_md && row.state !== "merged" && row.state !== "cancelled"
        ? row.evidence_md
        : undefined;
    // Thread replay: for chat threads, include prior turns so the cold
    // interviewer has conversational continuity. SQL filter + speaker mapping
    // live together in src/worker/thread-context.ts.
    const thread_replay = row.thread_id ? loadThreadContext(db, row.thread_id, id) : "";
    // Profile skills are the single source of truth (also printed by
    // hooks/session-start.sh). Agents without a profile (chat/bookie/unset)
    // throw here → leave undefined → templates falls back to AGENT_TABLE.
    let boot_skills: string[] | undefined;
    let stop_skills: string[] | undefined;
    try {
      const profile = loadProfile(row.agent);
      boot_skills = profile.boot_skills;
      stop_skills = profile.stop_skills;
    } catch (e) {
      // Missing file (chat/bookie/unset have no profile) → fall back to
      // AGENT_TABLE. But a malformed/schema-invalid *committed* profile is a
      // deploy defect; fail loud rather than silently demote every worker —
      // that silent degrade is the exact failure this single-source change
      // exists to prevent.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    process.stdout.write(
      renderSystemPrompt({
        kind: row.kind,
        agent: row.agent,
        pool: row.pool,
        worker,
        task: id,
        thread_id: row.thread_id ?? undefined,
        thread_replay,
        handoff,
        boot_skills,
        stop_skills,
      }),
    );
    break;
  }

  case "compact": {
    const db = openWithMigrate(getFlag("db"));
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const r = db.run(
      `DELETE FROM issues WHERE state IN ('merged','cancelled') AND updated_at < ?`,
      [cutoff],
    );
    out({ archived: r.changes });
    break;
  }

  case "vacuum": {
    // Three-pass GC (ADR 0006 §4):
    //   (1) --deliveries: prune hitl_deliveries on terminal prompts older than --older-than days
    //   (2) --artifacts:  unlink ~/vault/artifacts/ blobs unreferenced by any live delivery's prompt payload
    //   (3) default (no sub-flag): run both passes + SQLite VACUUM
    // --events: separate retention pass for issue_events on terminal (merged/
    //   cancelled) rows; preserves row + last merged event as audit anchor.
    // --dry-run: collect candidate lists for the same passes and return them
    //   as JSON WITHOUT mutating; never runs SQLite VACUUM. Combinable with
    //   any sub-flag (or none). Useful for inspecting before a destructive
    //   run — the count + candidate list is the operator's "are you sure".
    // Terminal prompt states per actual schema (009_hitl_prompts): answered,
    // user_confirmed, user_diverged, timeout_locked, cancelled.
    // Live delivery = state IN ('pending','delivered'). Artifact reachability
    // is by payload path field; sha-keyed dedup not yet a schema feature.
    const db = openWithMigrate(getFlag("db"));
    const dryRun = args.includes("--dry-run");
    if (args.includes("--events")) {
      // Retention GC for issue_events on terminal (merged/cancelled) rows.
      // Deletes events older than cutoff while preserving the row and its
      // last terminal event (merged/cancelled) as an audit anchor.
      const days = parseInt(getFlag("older-than") ?? "30", 10);
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      // Always compute the candidate set from the same WHERE clause as the
      // delete — single source of truth. In dry-run, return it; otherwise
      // run the DELETE and return the count (preserves pre-dry-run output
      // shape for the existing `vacuum --events` consumer).
      const candidates = db
        .query<{ seq: number; issue_id: string; kind: string; ts: number }, [number]>(
          `SELECT seq, issue_id, kind, ts FROM issue_events
           WHERE ts < ?
             AND issue_id IN (SELECT id FROM issues WHERE state IN ('merged','cancelled'))
             AND seq NOT IN (
               SELECT MAX(seq) FROM issue_events
               WHERE kind = 'merged'
               GROUP BY issue_id
             )
           ORDER BY issue_id, seq`,
        )
        .all(cutoff);
      if (dryRun) {
        out({
          dry_run: true,
          older_than_days: days,
          events: { would_delete: candidates.length, candidates },
        });
        break;
      }
      const r = db.run(
        `DELETE FROM issue_events
         WHERE ts < ?
           AND issue_id IN (SELECT id FROM issues WHERE state IN ('merged','cancelled'))
           AND seq NOT IN (
             SELECT MAX(seq) FROM issue_events
             WHERE kind = 'merged'
             GROUP BY issue_id
           )`,
        [cutoff],
      );
      out({ events_deleted: r.changes, older_than_days: days });
      break;
    }
    const olderDays = Number(getFlag("older-than") ?? "30");
    if (!Number.isFinite(olderDays) || olderDays < 0) die("--older-than must be a non-negative number");
    const onlyDeliveries = args.includes("--deliveries");
    const onlyArtifacts = args.includes("--artifacts");
    const runDeliveries = onlyDeliveries || (!onlyDeliveries && !onlyArtifacts);
    const runArtifacts = onlyArtifacts || (!onlyDeliveries && !onlyArtifacts);
    // SQLite VACUUM is non-mutating of user data (reclaims pages) but still a
    // multi-second operation; skip it in dry-run so the verb stays a no-op
    // observable. Sub-flag selectors still gate the destructive passes as
    // before — --dry-run just toggles collect vs delete.
    const runVacuum = !dryRun && !onlyDeliveries && !onlyArtifacts;

    const TERMINAL = "('answered','user_confirmed','user_diverged','timeout_locked','cancelled')";
    const cutoff = Math.floor(Date.now() / 1000) - olderDays * 24 * 3600;

    const result: Record<string, unknown> = { dry_run: dryRun, older_than_days: olderDays };

    if (runDeliveries) {
      // Collect candidates with the same WHERE the DELETE would use, joined
      // explicitly so the row identity is recoverable for the operator.
      const candidates = db
        .query<
          { prompt_id: string; module_name: string; state: string },
          [number]
        >(
          `SELECT d.prompt_id, d.module_name, d.state
           FROM hitl_deliveries d
           JOIN hitl_prompts p ON p.id = d.prompt_id
           WHERE p.state IN ${TERMINAL} AND p.created_at < ?
           ORDER BY d.prompt_id, d.module_name`,
        )
        .all(cutoff);
      if (dryRun) {
        result.deliveries = { would_delete: candidates.length, candidates };
      } else {
        const r = db.run(
          `DELETE FROM hitl_deliveries
           WHERE prompt_id IN (
             SELECT id FROM hitl_prompts
             WHERE state IN ${TERMINAL} AND created_at < ?
           )`,
          [cutoff],
        );
        result.deliveries_deleted = r.changes;
      }
    }

    if (runArtifacts) {
      const { readdirSync, statSync, unlinkSync, existsSync } = require("node:fs") as typeof import("node:fs");
      const { join: pjoin } = require("node:path") as typeof import("node:path");
      const dir = (process.env.HOME ?? "") + "/vault/artifacts";
      const reachable = new Set<string>();
      if (existsSync(dir)) {
        // Collect payload paths from prompts that still have a live delivery.
        const prompts = db
          .query<{ payload: string }, []>(
            `SELECT DISTINCT p.payload AS payload
             FROM hitl_prompts p
             JOIN hitl_deliveries d ON d.prompt_id = p.id
             WHERE d.state IN ('pending','delivered')`,
          )
          .all();
        for (const row of prompts) {
          try {
            const parsed = JSON.parse(row.payload) as { artifacts?: { path?: string }[] };
            for (const a of parsed.artifacts ?? []) {
              if (a.path) reachable.add(a.path);
            }
          } catch {
            // Skip malformed payload — log path for operator review.
          }
        }
        // Build the candidate list once, then either return it (dry-run) or
        // unlink it (apply). Splitting the IO from the decision means a bug
        // in the unlink loop can't poison the candidate set a dry-run user
        // sees — they get the answer to "what would happen" before any fs
        // mutation.
        const candidates: { path: string; size: number }[] = [];
        for (const name of readdirSync(dir)) {
          const full = pjoin(dir, name);
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          if (reachable.has(full)) continue;
          candidates.push({ path: full, size: st.size });
        }
        if (dryRun) {
          result.artifacts = {
            would_unlink: candidates.length,
            would_free_bytes: candidates.reduce((s, c) => s + c.size, 0),
            candidates,
          };
        } else {
          let unlinked = 0;
          let bytes = 0;
          for (const c of candidates) {
            bytes += c.size;
            try {
              unlinkSync(c.path);
              unlinked += 1;
            } catch {
              // Best-effort; continue.
            }
          }
          result.artifacts_unlinked = unlinked;
          result.artifacts_bytes_freed = bytes;
        }
      } else {
        if (dryRun) {
          result.artifacts = { would_unlink: 0, would_free_bytes: 0, candidates: [] };
        } else {
          result.artifacts_unlinked = 0;
          result.artifacts_bytes_freed = 0;
        }
      }
    }

    if (runVacuum) {
      db.exec("VACUUM");
      result.vacuumed = true;
    }

    out(result);
    break;
  }

  case "scratch-gc": {
    // List ~/vault/scratch/<slug>/ dirs with no mtime activity in >14d.
    // --root <path>     override scratch root (default ~/vault/scratch)
    // --days <N>        staleness threshold (default 14)
    // --apply           delete stale dirs (default: dry-run)
    const { readdirSync, statSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { join: pjoin } = require("node:path") as typeof import("node:path");
    const root = getFlag("root") ?? `${process.env.HOME}/vault/scratch`;
    const days = parseInt(getFlag("days") ?? "14", 10);
    const apply = args.includes("--apply");
    const cutoff = Date.now() - days * 86400 * 1000;

    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      out({ root, stale: [], deleted: [], note: "root not found" });
      break;
    }

    // Recursive mtime check: max mtime over dir tree.
    function maxMtime(p: string): number {
      let m = statSync(p).mtimeMs;
      try {
        for (const e of readdirSync(p)) {
          const sub = pjoin(p, e);
          let s;
          try { s = statSync(sub); } catch { continue; }
          if (s.isDirectory()) {
            const mm = maxMtime(sub);
            if (mm > m) m = mm;
          } else if (s.mtimeMs > m) m = s.mtimeMs;
        }
      } catch { /* unreadable */ }
      return m;
    }

    const stale: { path: string; last_activity: string }[] = [];
    for (const name of entries) {
      const p = pjoin(root, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (!s.isDirectory()) continue;
      const mt = maxMtime(p);
      if (mt < cutoff) stale.push({ path: p, last_activity: new Date(mt).toISOString() });
    }

    const deleted: string[] = [];
    if (apply) {
      for (const s of stale) {
        rmSync(s.path, { recursive: true, force: true });
        deleted.push(s.path);
      }
    }
    out({ root, days, apply, stale, deleted });
    break;
  }

  case "doctor": {
    // Pure-read health probe. Surfaces lifecycle anomalies a /loop iteration
    // would otherwise have to assemble by hand:
    //   - phantom_claims: rows with claimed_by set while state is non-claim
    //     (should be 0 after migration 015's trigger)
    //   - stale_claims: claimed/wip rows whose claim has aged past --stale-hours
    //     (default 4hr; matches factory.ts reap threshold)
    //   - state_counts: tally of issues by state
    //   - untracked_worktree_dirs: <repo>-* dirs under --worktree-root that
    //     git doesn't know about (orphan scratch leaks)
    //   - mergeable_worktrees: registered worktrees whose HEAD is an ancestor
    //     of main — safe to reap manually
    // Flags:
    //   --stale-hours N      claim age cutoff (default 4)
    //   --worktree-root P    scan root (default ~/worktrees)
    //   --repo-prefix S      dir prefix to consider (default "arc-agents-")
    //   - project_misroutes: kind=task rows with project='' (default
    //     arc-agents) whose body references a sibling repo name under
    //     --repos-root, i.e. the row was likely filed against the wrong
    //     project (see project-repo-map.ts for the project->dir mapping)
    // Flags:
    //   --stale-hours N      claim age cutoff (default 4)
    //   --worktree-root P    scan root (default ~/worktrees)
    //   --repo-prefix S      dir prefix to consider (default "arc-agents-")
    //   --repos-root P       sibling-repos scan root (default ~/repos)
    //   --strict             exit 1 if any anomaly present (phantom/stale
    //                        claims, untracked worktree dirs, scan error,
    //                        project misroutes).
    //                        mergeable_worktrees is informational and never
    //                        triggers a non-zero exit on its own.
    const { readdirSync, existsSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { join: pjoin } = require("node:path") as typeof import("node:path");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

    const db = openWithMigrate(getFlag("db"));
    const staleHours = parseInt(getFlag("stale-hours") ?? "4", 10);
    const worktreeRoot = getFlag("worktree-root") ?? `${process.env.HOME}/worktrees`;
    const repoPrefix = getFlag("repo-prefix") ?? "arc-agents-";
    const reposRoot = getFlag("repos-root") ?? `${process.env.HOME}/repos`;
    const staleCutoff = Math.floor(Date.now() / 1000) - staleHours * 3600;

    const phantomClaims = db
      .query<{ id: string; state: string; claimed_by: string; claimed_at: number | null }, []>(
        `SELECT id, state, claimed_by, claimed_at FROM issues
         WHERE claimed_by IS NOT NULL AND state NOT IN ('claimed','wip')
         ORDER BY updated_at DESC`,
      )
      .all();

    const staleClaims = db
      .query<{ id: string; state: string; claimed_by: string; claimed_at: number; age_hours: number }, [number]>(
        `SELECT id, state, claimed_by, claimed_at,
                ROUND((strftime('%s','now') - claimed_at) / 3600.0, 1) AS age_hours
         FROM issues
         WHERE state IN ('claimed','wip')
           AND claimed_at IS NOT NULL
           AND claimed_at < ?
         ORDER BY claimed_at ASC`,
      )
      .all(staleCutoff);

    const stateCounts = db
      .query<{ state: string; n: number }, []>(
        `SELECT state, COUNT(*) AS n FROM issues GROUP BY state ORDER BY n DESC`,
      )
      .all();

    // project_misroutes: kind=task rows filed against the default project
    // (project IS NULL or '') whose body mentions a sibling repo dir name
    // (e.g. "arc-webui") as a whole word — a strong signal the row belongs
    // to that project instead. Only sibling dirs under reposRoot other than
    // "arc-agents" itself are candidates; word-boundary match avoids
    // matching substrings inside unrelated identifiers.
    const misrouteCandidates: string[] = existsSync(reposRoot)
      ? readdirSync(reposRoot).filter((n) => {
          if (n === "arc-agents") return false;
          try { return statSync(pjoin(reposRoot, n)).isDirectory(); } catch { return false; }
        })
      : [];

    const defaultProjectTasks = db
      .query<{ id: string; body_md: string | null }, []>(
        `SELECT id, body_md FROM issues WHERE kind = 'task' AND (project IS NULL OR project = '')`,
      )
      .all();

    const projectMisroutes: { id: string; suspected_project: string }[] = [];
    for (const row of defaultProjectTasks) {
      if (!row.body_md) continue;
      for (const candidate of misrouteCandidates) {
        const re = new RegExp(`\\b${escapeRe(candidate)}\\b`);
        if (re.test(row.body_md)) {
          projectMisroutes.push({ id: row.id, suspected_project: candidate });
          break;
        }
      }
    }

    let untrackedWorktreeDirs: string[] = [];
    let mergeableWorktrees: { path: string; branch: string | null }[] = [];
    let worktreeScanError: string | null = null;

    if (existsSync(worktreeRoot)) {
      const dirs = readdirSync(worktreeRoot).filter((n) => n.startsWith(repoPrefix));
      // Probe matching dirs until one is a real git worktree whose `git worktree
      // list` succeeds. The first dir by readdir order may be an orphan (a
      // leftover non-git dir) — anchoring blindly on it makes the git call fatal
      // and silently empties the whole scan, so the orphan never gets reported
      // as untracked. readdir order differs across filesystems (CI surfaced the
      // orphan-first case), so we can't rely on a real worktree sorting first.
      // ponytail: linear probe over a handful of worktree dirs.
      const candidates = dirs.filter((n) => {
        try { return statSync(pjoin(worktreeRoot, n)).isDirectory(); }
        catch { return false; }
      });
      let sample: string | null = null;
      let wt: { stdout: string; stderr: string; status: number | null } | null = null;
      for (const n of candidates) {
        const cand = pjoin(worktreeRoot, n);
        const probe = spawnSync("git", ["-C", cand, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        });
        if (probe.status === 0) { sample = cand; wt = probe; break; }
      }

      if (sample && wt) {
          // Parse porcelain: blocks separated by blank lines, each starts with `worktree <path>`.
          const registered = new Map<string, string | null>();
          let curPath: string | null = null;
          let curBranch: string | null = null;
          for (const line of wt.stdout.split("\n")) {
            if (line.startsWith("worktree ")) {
              if (curPath) registered.set(curPath, curBranch);
              curPath = line.slice("worktree ".length).trim();
              curBranch = null;
            } else if (line.startsWith("branch ")) {
              curBranch = line.slice("branch ".length).trim();
            } else if (line === "" && curPath) {
              registered.set(curPath, curBranch);
              curPath = null;
              curBranch = null;
            }
          }
          if (curPath) registered.set(curPath, curBranch);

          // Untracked: present on disk but not in `git worktree list`.
          const fullDirs = dirs
            .map((n) => pjoin(worktreeRoot, n))
            .filter((p) => {
              try { return statSync(p).isDirectory(); } catch { return false; }
            });
          untrackedWorktreeDirs = fullDirs.filter((p) => !registered.has(p));

          // Mergeable: registered worktree under worktreeRoot whose HEAD is a
          // STRICT ancestor of main — reachable from main's tip AND not equal to
          // it. The strictness matters: a freshly-created `worktree add … main`
          // has HEAD == main's tip, which is trivially its own ancestor, so a
          // plain is-ancestor check flags every just-booted worker worktree as
          // "done" and (under ARC_AUTO_PRUNE) deletes it out from under the live
          // worker. A merged worktree, by contrast, sits strictly behind main's
          // advanced tip (main moved on past it). HEAD != main-tip cleanly
          // separates merged (reap) from fresh/untouched (leave alone).
          // Scoping to worktreeRoot keeps results aligned with
          // untrackedWorktreeDirs (same scan window) and skips the main checkout
          // + sibling worktrees outside the operator's chosen root.
          const rootPrefix = worktreeRoot.replace(/\/+$/, "") + "/";
          // Resolve main's tip in the SAME git dir the worktrees belong to
          // (anchor on `sample`, a known worktree of that repo). A bare
          // `git rev-parse main` would resolve main in the doctor process's
          // own cwd — a different repo entirely — yielding a SHA that never
          // matches any scanned HEAD and silently disabling the guard.
          const mainTip = spawnSync("git", ["-C", sample, "rev-parse", "main"], { encoding: "utf8" });
          const mainTipSha = mainTip.status === 0 ? mainTip.stdout.trim() : "";
          for (const [path, branch] of registered) {
            if (!path.startsWith(rootPrefix)) continue;
            const head = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
            if (head.status !== 0) continue;
            const headSha = head.stdout.trim();
            // Fresh/untouched worktree (HEAD still at main's tip) has produced
            // nothing to merge — never reap it. Only a worktree whose HEAD has
            // diverged-then-landed (strictly behind the advanced tip) is mergeable.
            if (!mainTipSha || headSha === mainTipSha) continue;
            const ancestor = spawnSync(
              "git",
              ["-C", path, "merge-base", "--is-ancestor", headSha, "main"],
              { encoding: "utf8" },
            );
            if (ancestor.status === 0) {
              mergeableWorktrees.push({ path, branch });
            }
          }
        } else if (candidates.length > 0) {
          // Matching dirs exist but none is a scannable git worktree (all
          // orphans) — we have no git anchor to compare against.
          worktreeScanError = "no scannable git worktree among matching dirs";
        }
    } else {
      worktreeScanError = `worktree root not found: ${worktreeRoot}`;
    }

    const report = {
      stale_hours: staleHours,
      worktree_root: worktreeRoot,
      repo_prefix: repoPrefix,
      phantom_claims: phantomClaims,
      stale_claims: staleClaims,
      state_counts: stateCounts,
      untracked_worktree_dirs: untrackedWorktreeDirs,
      mergeable_worktrees: mergeableWorktrees,
      worktree_scan_error: worktreeScanError,
      project_misroutes: projectMisroutes,
    };

    const strict = args.includes("--strict");
    const anomalyCount =
      phantomClaims.length +
      staleClaims.length +
      untrackedWorktreeDirs.length +
      (worktreeScanError ? 1 : 0) +
      projectMisroutes.length;

    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      if (strict && anomalyCount > 0) process.exit(1);
      break;
    }

    // Human-readable table. Mirrors the JSON shape so a reader can grep without
    // remembering field names: same labels, just laid out for a tmux pane.
    const lines: string[] = [];
    lines.push(`ledger doctor  (stale_hours=${staleHours}, worktree_root=${worktreeRoot})`);
    lines.push("");
    lines.push("state_counts:");
    if (stateCounts.length === 0) lines.push("  (empty)");
    else for (const { state, n } of stateCounts) lines.push(`  ${state.padEnd(10)} ${n}`);
    lines.push("");
    lines.push(`phantom_claims:   ${phantomClaims.length}`);
    if (phantomClaims.length > 0) {
      for (const r of phantomClaims.slice(0, 5)) {
        lines.push(`  - ${r.id}  state=${r.state}  by=${r.claimed_by}`);
      }
      if (phantomClaims.length > 5) lines.push(`  ... +${phantomClaims.length - 5} more`);
    }
    lines.push(`stale_claims:     ${staleClaims.length}`);
    if (staleClaims.length > 0) {
      for (const r of staleClaims.slice(0, 5)) {
        lines.push(`  - ${r.id}  state=${r.state}  by=${r.claimed_by}  age=${r.age_hours}h`);
      }
      if (staleClaims.length > 5) lines.push(`  ... +${staleClaims.length - 5} more`);
    }
    lines.push(`untracked_worktree_dirs: ${untrackedWorktreeDirs.length}`);
    for (const p of untrackedWorktreeDirs.slice(0, 5)) lines.push(`  - ${p}`);
    if (untrackedWorktreeDirs.length > 5) {
      lines.push(`  ... +${untrackedWorktreeDirs.length - 5} more`);
    }
    lines.push(`mergeable_worktrees:     ${mergeableWorktrees.length}`);
    for (const w of mergeableWorktrees.slice(0, 5)) {
      lines.push(`  - ${w.path}  ${w.branch ?? "(detached)"}`);
    }
    if (mergeableWorktrees.length > 5) {
      lines.push(`  ... +${mergeableWorktrees.length - 5} more`);
    }
    if (worktreeScanError) {
      lines.push("");
      lines.push(`worktree_scan_error: ${worktreeScanError}`);
    }
    lines.push(`project_misroutes:       ${projectMisroutes.length}`);
    for (const r of projectMisroutes.slice(0, 5)) {
      lines.push(`  - ${r.id}  suspected_project=${r.suspected_project}`);
    }
    if (projectMisroutes.length > 5) {
      lines.push(`  ... +${projectMisroutes.length - 5} more`);
    }
    console.log(lines.join("\n"));
    if (strict && anomalyCount > 0) process.exit(1);
    break;
  }

  case "backfill-phantom-claims": {
    // One-shot maintenance: NULL claimed_by + claimed_at on rows whose state is
    // not 'claimed' or 'wip'. Migration 015's trigger prevents new phantoms, so
    // this only matters for the pre-trigger backlog (the rows doctor surfaces
    // under phantom_claims). Pure data change, no state-machine impact.
    //
    //   --apply   write changes (default: dry-run)
    //   --json    machine-readable output (default: human line)
    const db = openWithMigrate(getFlag("db"));
    const apply = args.includes("--apply");

    const targets = db
      .query<{ id: string; state: string; claimed_by: string }, []>(
        `SELECT id, state, claimed_by FROM issues
         WHERE claimed_by IS NOT NULL AND state NOT IN ('claimed','wip')
         ORDER BY updated_at DESC`,
      )
      .all();

    let updated = 0;
    if (apply && targets.length > 0) {
      const r = db.run(
        `UPDATE issues SET claimed_by = NULL, claimed_at = NULL
         WHERE claimed_by IS NOT NULL AND state NOT IN ('claimed','wip')`,
      );
      updated = r.changes;
    }

    const report = { found: targets.length, applied: apply, updated, sample: targets.slice(0, 5) };
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    const verb = apply ? `cleared ${updated}` : `would clear ${targets.length} (dry-run; pass --apply to write)`;
    console.log(`backfill-phantom-claims: ${verb}`);
    if (targets.length > 0) {
      for (const r of targets.slice(0, 5)) {
        console.log(`  - ${r.id}  state=${r.state}  by=${r.claimed_by}`);
      }
      if (targets.length > 5) console.log(`  ... +${targets.length - 5} more`);
    }
    break;
  }

  case "resolve-alias": {
    // resolve-alias <issueId> [--db <path>]
    // Pure read: looks up the issue's agent field (if the column exists), loads
    // its profile to get exec_cli_alias, and prints the alias NAME on stdout.
    // If the agent column does not exist yet (pre-migration) or the value is
    // absent/null/"agent_unset", falls back to config.default_alias.
    // This makes the verb forward-compatible: always falls back in PR-1, will
    // work automatically once the agent DB column lands in a later PR.
    const issueId = positionalAfterVerb()[0] ?? die("issue id required");
    // Pure read on the hot worker-spawn path: open read-only so this never
    // triggers a migration write (worker-shell.sh's bootstrap claim is the
    // only ledger write permitted to bypass the bookie).
    const dbPath = getFlag("db") ?? process.env.ARC_LEDGER_DB ?? `${process.env.HOME}/vault/ledger.db`;
    const db = new Database(dbPath, { readonly: true });
    const appCfg = loadAppConfig();

    // Check whether the `agent` column exists on the issues table.
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(issues)")
      .all()
      .map((r) => r.name);
    const hasAgentCol = columns.includes("agent");

    let aliasName = appCfg.default_alias;
    if (hasAgentCol) {
      const row = db
        .query<{ agent: string | null }, [string]>("SELECT agent FROM issues WHERE id=?")
        .get(issueId);
      if (!row) die(`no such issue: ${issueId}`);
      const agentVal = row.agent;
      if (agentVal && agentVal !== "agent_unset") {
        try {
          const profile = loadProfile(agentVal);
          aliasName = profile.exec_cli_alias;
        } catch {
          // Profile not found — fall back to default_alias silently.
          aliasName = appCfg.default_alias;
        }
      }
    }
    process.stdout.write(aliasName + "\n");
    break;
  }

  case "alias-cmd": {
    // alias-cmd <aliasName>
    // Pure read: prints the alias GROUP — one failover candidate command per
    // line, in priority order (with {prompt} placeholder intact). A bare-string
    // alias prints one line. worker-shell.sh reads these into a bash array and
    // tries each in turn (G-0006 N-tier escalation). Respects ARC_DISABLE_CLAUDE
    // (ProgramBench overlay): claude/claude-afk candidates are dropped.
    const aliasName = positionalAfterVerb()[0] ?? die("alias name required");
    const appCfg = loadAppConfig();
    process.stdout.write(getAliasCommands(aliasName, appCfg).join("\n") + "\n");
    break;
  }

  case undefined: {
    // AXI P8: bare `ledger` (no args) shows live state (ready queue) instead
    // of a usage screen. Zero-friction default = useful work.
    const db = openWithMigrate(getFlag("db"));
    const sql = `SELECT id, state, kind, type, title FROM issues WHERE state='ready' ORDER BY ${SORT_KEY_SQL} LIMIT ?`;
    const limit = parseInt(getFlag("limit") ?? "100", 10);
    out(db.query(sql).all(limit));
    if (process.stderr.isTTY) {
      const readyCount = (db.query(`SELECT COUNT(*) AS n FROM issues WHERE state='ready'`).get() as { n: number }).n;
      process.stderr.write(`Next: claim <id> to start, or \`ledger list\` for filters (${readyCount} ready).\n`);
    }
    break;
  }

  case "director-brief": {
    // Thin I/O shell over the pure src/director/director-brief.ts module (slice 6).
    // Gathers three project sources, calls brief(), renders each bucket via
    // toon-encode with definitive empty states + size hints. AXI-conformant.
    const project = getFlag("project") ?? die("--project required");
    const cap = getFlag("cap") !== undefined ? parseInt(getFlag("cap")!, 10) : undefined;
    const db = openWithMigrate(getFlag("db"));

    // DONE: last ~20 commit subjects from git log (cwd repo by default; --repo overrides).
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const repo = getFlag("repo") ?? process.cwd();
    const git = spawnSync("git", ["-C", repo, "log", "--oneline", "-20", "--no-color"], {
      encoding: "utf8",
    });
    const gitLog: GitLogEntry[] = (git.status === 0 ? git.stdout : "")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const sp = l.indexOf(" ");
        return sp === -1
          ? { sha: l, subject: "" }
          : { sha: l.slice(0, sp), subject: l.slice(sp + 1) };
      });

    // CURRENT + NEXT source: project ledger rows (reuse the existing issues read path).
    const ledgerRows = db
      .query<{ id: string; title: string; state: string; claimed_by: string | null }, [string]>(
        `SELECT id, title, state, claimed_by FROM issues WHERE project=? ORDER BY ${SORT_KEY_SQL}`,
      )
      .all(project)
      .map((r) => ({ id: r.id, title: r.title, state: r.state, claimedBy: r.claimed_by ?? undefined }));

    // NEXT also includes OPEN feedback for the project (existing feedback table; open =
    // not-yet-resolved/closed). body_md is the summary line.
    const feedback = db
      .query<{ id: string; body_md: string }, [string]>(
        `SELECT id, body_md FROM feedback WHERE project=? AND state IN ('new','OPEN','DEV') ORDER BY created_at DESC`,
      )
      .all(project)
      .map((f) => ({ id: f.id, summary: f.body_md }));

    const b = directorBrief(gitLog, ledgerRows, feedback, cap !== undefined ? { cap } : undefined);

    const render = (items: { ref: string; label: string }[]) =>
      items.length === 0
        ? "(nothing)"
        : toonEncode(items.map((i) => ({ ref: i.ref, label: i.label })) as Record<string, unknown>[]);

    const report = {
      project,
      done: render(b.done),
      current: render(b.current),
      next: render(b.next),
      hints: b.hints,
    };
    out(report);
    break;
  }

  case "-h":
  case "--help":
  case "help": {
    console.log(`ledger <verb> [args]

  init                                 run migrations
  create --kind --type --title [...]   insert row (flag-only)
                                       flags: --project --body --acceptance --parent --blocked-by --agent
  claim <worker> [--type T]            atomic claim of highest-priority ready task
                                       (--type restricts to one priority class)
  print-claim-sql [--type-filter]      emit canonical claim SQL (src/ledger/claim.ts)
                                       to stdout for ops/debug; --type-filter
                                       includes the AND type=?2 variant
  decompose <parent> --child T [...]   atomic: create N HITL children, parent → blocked
  repoint-blocked-by <id> <blockerId...>
                                       repoint an existing blocked row's blocked_by to
                                       different sibling id(s); row must be state=blocked
  update <id> [--state --evidence --pr --local-merged-sha --in-place --no-diff --branch --worktree --hitl 0|1 --agent --project]
                                       state=merged requires one of:
                                         --pr <url-or-#num>        gh pr view must say MERGED
                                         --local-merged-sha <sha>  sha must be on origin/main
                                         --in-place                explicit in-place acknowledgement (refused on non-owned repos; --force-in-place overrides)
                                                                  (no PR/sha verification; --evidence
                                                                  is the receipt; mutex with --pr).
                                       --no-diff skips the diff_review requirement for a
                                       correct negative-result merge (nothing to trash, N<3
                                       sample, fix already landed); requires --evidence
                                       naming the negative result. Still needs --pr/
                                       --local-merged-sha/--in-place like any merge.
                                       Override with ARC_SKIP_MERGE_TRUTH=1.
                                       --agent/--project patch the row (metadata update, no
                                       --state). With --state, --agent names the event author;
                                       use --agent-set to reassign the row's agent alongside a state change.
  event <id> <kind> <payload>          append event row
  hitl emit --class taste|impact --kind <K> --prompt <q> [--option ...]
            [--recommended X --timeout-sec N --divergence forward_fix|replay]
                                       emit HITL prompt + fanout to alive UX modules
  hygiene-emit --skill <s> --title <t> [--body <b>] [--observed-in-task <id>]
                                       [--project <p>]
                                       emit hygiene followup row (class=hygiene type=quality)
                                       skills: clarify-docs, improve-architecture,
                                               trash-retired-files, analyse-recent-sessions
                                       dedups against ready/blocked/wip/claimed hygiene rows
                                       --project defaults to the observed-in-task row's
                                       project (single source of truth); falls back to
                                       'arc-agents' when neither is set.
  trash-sweep [--apply] [--dir PATH]    prune trash files past their .ttl sweep_after;
                                        dry-run by default; --apply actually deletes
  list [--state --kind --type --created-by --limit --all]   (alias: ls)
                                       default excludes terminal (merged/
                                       cancelled/failed); --all includes them
  show <id>
  tick                                 cascade-unblock + reclaim stale (>2hr) claims
  spawn-ready [--type]                 emit JSON for ready rows
  render-prompt <id> [--worker W]      render worker system prompt for issue
  compact                              archive merged/cancelled > 30d
  vacuum [--events | --deliveries | --artifacts] [--older-than N] [--dry-run]
                                       Default (no sub-flag): GC HITL deliveries
                                       on terminal prompts, unlink unreachable
                                       ~/vault/artifacts/ blobs, then SQLite VACUUM.
                                       --events: GC issue_events on merged/cancelled
                                       rows older than N days (default 30); retains
                                       row + last merged event as audit anchor.
                                       --dry-run: collect candidate lists (per-pass
                                       would_delete/would_unlink + row ids + paths)
                                       and return as JSON WITHOUT mutating; never
                                       runs SQLite VACUUM. Combinable with any
                                       sub-flag (or none). Output shape adds
                                       dry_run:true and a per-pass candidates
                                       array.
  scratch-gc [--root P --days N --apply]
                                       list/delete stale ~/vault/scratch/<slug>/ dirs
  doctor [--stale-hours N --worktree-root P --repo-prefix S --repos-root P
          --json --strict]
                                       pure-read health probe: phantom_claims,
                                       stale_claims (>N hr, default 4),
                                       state_counts, untracked_worktree_dirs,
                                       mergeable_worktrees, project_misroutes
                                       (kind=task rows filed against the
                                       default project whose body names a
                                       sibling repo under --repos-root,
                                       default ~/repos). Default output is a
                                       human table; --json emits the raw report.
                                       --strict exits 1 on any anomaly
                                       (phantom/stale/untracked/scan_error);
                                       mergeable_worktrees alone does not.
  backfill-phantom-claims [--apply --json]
                                       one-shot: NULL claimed_by/claimed_at on
                                       rows whose state is terminal or non-claim
                                       (the doctor phantom_claims backlog).
                                       Default dry-run; --apply writes.

  director-brief --project <P> [--cap N --repo <path>]
                                       pure read: done (git log) / current (in-flight
                                       ledger) / next (queued+blocked ledger + open
                                       feedback) for a project group; TOON buckets +
                                       size hints
  resolve-alias <issueId> [--db <path>]   pure read: print alias NAME for issue's agent
  alias-cmd <aliasName>                   pure read: print full command string for alias
                                          (includes {prompt} placeholder)

  --db <path>  (must come AFTER the verb; e.g. ledger show <id> --db /path/to/ledger.db)

NOTE: agents must route all WRITES (create, update, decompose, event) through
the bookie subagent. Direct CLI writes are reserved for bootstrap (worker-shell
claim) and human operators. Reads (list, show, spawn-ready) are unrestricted.`);
    break;
  }

  default:
    die(`unknown verb: ${cmd}`);
}
