#!/usr/bin/env bun
// arc-ux — the verb shim the interviewer (and class=taste workers) call to
// surface HITL prompts. See ADR 0002 — UX Module Contract.
//
// Subcommands (all read --class taste|impact; default taste):
//   ask-text     --prompt "..." [--recommended "..."] [--timeout 60] [--strategy forward_fix|replay] [--class ...]
//   ask-choice   --prompt "..." --options "a,b,c" [--recommended "a"] [--timeout 60] [--strategy ...] [--class ...]
//   ask-confirm  --prompt "..." [--recommended "yes"] [--timeout 60] [--class ...]
//   notify       --message "..." [--level info|warn|error]
//   show-artifact --caption "..." --artifact path/or/-          (one --artifact per call, repeatable)
//
// Class semantics (ADR 0002, U-0002, U-0003):
//   taste:  inserts row + deliveries, anchors HEAD, returns `recommended` immediately.
//           A reconciler watches for divergence and triggers forward_fix/replay.
//   impact: must be invoked from interviewer (ARC_ROLE=interviewer). Inserts row +
//           deliveries, then blocks until state=answered. Returns the answer.
//
// notify is broadcast/fire-and-forget — no claim, no wait, all alive modules consume.
//
// Exit codes: 0 ok, 2 usage error, 3 no alive module / bookie refusal,
//             4 worker tried class=impact, 5 timed out waiting (impact only).

import { spawnSync } from "child_process";
import { open } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { type HitlKind } from "../src/ledger/hitl-schemas";
import { loadConfig, pickModulesForHitl } from "../src/ledger/ux-config";
import { buildPayload, insertHitlPrompt } from "../src/ledger/hitl-prompt";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}
function flagAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) {
      const v = args[i + 1];
      if (v !== undefined) out.push(v);
    } else if (a.startsWith(`--${name}=`)) {
      out.push(a.slice(a.indexOf("=") + 1));
    }
  }
  return out;
}

function die(code: number, msg: string): never {
  process.stderr.write(`arc-ux: ${msg}\n`);
  process.exit(code);
}

function gitAnchor(): { repo: string; branch: string; commit: string } | null {
  const repoR = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (repoR.status !== 0) return null;
  const branchR = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  const commitR = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (branchR.status !== 0 || commitR.status !== 0) return null;
  return {
    repo: repoR.stdout.trim(),
    branch: branchR.stdout.trim(),
    commit: commitR.stdout.trim(),
  };
}

function bootstrapTaskIfNeeded(reason: string): void {
  // Pre-check: if a non-terminal "Install a UX surface module" issue is already
  // queued, no-op. mintId (src/ledger/db.ts) appends a random suffix on PK
  // collision rather than failing, so without this guard every refusal floods
  // the queue with duplicate install tasks.
  const db = open();
  const existing = db
    .query<{ id: string }, []>(
      `SELECT id FROM issues
       WHERE title = 'Install a UX surface module'
         AND state NOT IN ('merged','cancelled')
       LIMIT 1`,
    )
    .get();
  db.close();
  if (existing) return;

  // First-time spawn: shell out to the bookie via `ledger create` so we don't
  // duplicate its validation here.
  spawnSync(
    "bun",
    [
      `${import.meta.dir}/ledger.ts`,
      "create",
      "--title",
      "Install a UX surface module",
      "--kind",
      "task",
      "--type",
      "mvp",
      "--body",
      `arc-ux refused HITL write: ${reason}. Install or revive a module that fulfills the UX Module Contract (ADR 0002).`,
    ],
    { stdio: "inherit" },
  );
}

function emitPrompt(opts: {
  kind: HitlKind;
  cls: "taste" | "impact";
  payload: unknown;
  recommended: string | null;
  strategy: "forward_fix" | "replay" | null;
  timeoutSec: number | null;
  anchor: { repo: string; branch: string; commit: string } | null;
}): { id: string; deliveries: string[] } {
  const db = open();
  migrate(db);
  const cfg = loadConfig();
  // Pre-flight the liveness gate. insertHitlPrompt's dead-surface fallback parks
  // undeliverable asks instead of throwing, which is right for the fire-and-forget
  // `ledger hitl emit` path — but arc-ux blocks in waitForAnswer() right after,
  // so a parked row here would hang the caller until timeout with nobody able to
  // answer. Refuse up front (exit 3 + bootstrap task) and write no row.
  if (pickModulesForHitl(db, cfg, opts.kind).length === 0) {
    bootstrapTaskIfNeeded(`no alive module implements ${opts.kind}`);
    die(3, `no alive UX module implements ${opts.kind}; bootstrap task spawned`);
  }
  try {
    const res = insertHitlPrompt(db, {
      kind: opts.kind,
      cls: opts.cls,
      payload: opts.payload,
      recommended: opts.recommended,
      strategy: opts.strategy,
      timeoutSec: opts.timeoutSec,
      anchor: opts.anchor,
      emittedBy: process.env.ARC_ROLE ?? null,
      cfg,
    });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Remaining throws are render-capability/payload failures (exit 2). The
    // "no alive module" case is handled by the pre-flight above.
    if (msg.startsWith("kind:")) {
      bootstrapTaskIfNeeded(`no alive module implements ${opts.kind}`);
      die(3, `no alive UX module implements ${opts.kind}; bootstrap task spawned`);
    }
    die(2, msg);
  }
}

function waitForAnswer(promptId: string, timeoutSec: number | null): { state: string; answer: string | null } {
  // Cheap poll: 500ms cadence, bounded by timeoutSec (null = no bound).
  const db = open();
  const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : null;
  const q = db.query<{ state: string; answer: string | null }, [string]>(
    "SELECT state, answer FROM hitl_prompts WHERE id=?",
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const row = q.get(promptId);
    if (!row) die(1, `prompt ${promptId} vanished`);
    if (row.state !== "open") return row;
    if (deadline && Date.now() >= deadline) return row;
    Bun.sleepSync(500);
  }
}

function readArtifact(spec: string): { type: string; inline?: string; path?: string } {
  // Format: "<type>:<inline-or-path>". Path beginning with @ is a file ref.
  // e.g. "text/markdown:hello"  or  "image/png:@/tmp/x.png"  or  "text/diff:-" (stdin).
  const idx = spec.indexOf(":");
  if (idx < 0) die(2, `bad --artifact spec: ${spec}`);
  const type = spec.slice(0, idx);
  const rest = spec.slice(idx + 1);
  if (rest === "-") {
    const buf = Buffer.from(require("fs").readFileSync(0));
    return { type, inline: buf.toString("utf8") };
  }
  if (rest.startsWith("@")) return { type, path: rest.slice(1) };
  return { type, inline: rest };
}

function commonAsk(kind: HitlKind, payload: unknown): { ok: boolean; out?: { id: string; answer: string | null; state: string } } {
  const cls = (flag("class") ?? "taste") as "taste" | "impact";
  if (cls !== "taste" && cls !== "impact") die(2, `--class must be taste|impact`);

  if (cls === "impact" && process.env.ARC_ROLE && process.env.ARC_ROLE !== "interviewer") {
    die(4, `class=impact requires ARC_ROLE=interviewer (got '${process.env.ARC_ROLE}'). Workers must decompose, not block.`);
  }

  // Ack-only kinds (show_artifact) have no answer to recommend, but the schema
  // CHECK constraint requires class='taste' rows to have a non-null `recommended`
  // (see src/ledger/migrate.ts:254). Mirror the notify path's sentinel.
  const isAckOnly = kind === "show_artifact";
  const recommended = flag("recommended") ?? (isAckOnly ? "(show_artifact)" : null);
  if (cls === "taste" && !recommended) die(2, `class=taste requires --recommended`);

  const strategyRaw = flag("strategy") ?? "forward_fix";
  if (strategyRaw !== "forward_fix" && strategyRaw !== "replay") {
    die(2, `--strategy must be forward_fix|replay`);
  }
  const strategy = cls === "taste" ? (strategyRaw as "forward_fix" | "replay") : null;

  const timeoutSec = cls === "taste" ? Number(flag("timeout") ?? 60) : null;

  // Validate payload shape via the consolidated build path.
  const validated = buildPayload(kind, payload as Parameters<typeof buildPayload>[1]);

  const anchor = cls === "taste" ? gitAnchor() : null;
  const { id } = emitPrompt({
    kind,
    cls,
    payload: validated,
    recommended,
    strategy,
    timeoutSec,
    anchor,
  });

  if (cls === "taste") {
    // Return recommendation immediately. Reconciler handles divergence later.
    process.stdout.write(JSON.stringify({ id, answer: recommended, speculative: true }) + "\n");
    return { ok: true };
  }

  // impact: block until answered. No client-side timeout — user owns the clock.
  const result = waitForAnswer(id, null);
  if (result.state === "answered" || result.state === "user_confirmed") {
    process.stdout.write(JSON.stringify({ id, answer: result.answer, speculative: false }) + "\n");
    return { ok: true };
  }
  die(5, `prompt ${id} ended in state ${result.state}`);
}

switch (cmd) {
  case "ask-text": {
    const prompt = flag("prompt") ?? die(2, "--prompt required");
    commonAsk("ask_text", { prompt, artifacts: [] });
    break;
  }
  case "ask-choice": {
    const prompt = flag("prompt") ?? die(2, "--prompt required");
    const optsStr = flag("options") ?? die(2, "--options required (comma-separated)");
    const options = optsStr.split(",").map((s) => s.trim()).filter(Boolean);
    if (options.length < 2) die(2, "--options needs at least 2 entries");
    commonAsk("ask_choice", { prompt, options, artifacts: [] });
    break;
  }
  case "ask-confirm": {
    const prompt = flag("prompt") ?? die(2, "--prompt required");
    commonAsk("ask_confirm", { prompt, artifacts: [] });
    break;
  }
  case "notify": {
    const message = flag("message") ?? die(2, "--message required");
    const level = (flag("level") ?? "info") as "info" | "warn" | "error";
    // notify is broadcast, never claimed, never waited on. Same row machinery,
    // but state goes straight to 'answered' once any module acks — or we leave
    // it 'open' with a short expires_at and let the reconciler reap it.
    const validated = buildPayload("notify", { message, level });
    const { id, deliveries } = emitPrompt({
      kind: "notify",
      cls: "taste",
      payload: validated,
      recommended: "(notify)",
      strategy: null,
      timeoutSec: 3600,
      anchor: null,
    });
    process.stdout.write(JSON.stringify({ id, broadcast: deliveries }) + "\n");
    break;
  }
  case "show-artifact": {
    const caption = flag("caption");
    const artSpecs = flagAll("artifact");
    if (artSpecs.length === 0) die(2, "show-artifact needs at least one --artifact");
    const artifacts = artSpecs.map(readArtifact);
    commonAsk("show_artifact", { caption, artifacts });
    break;
  }
  default:
    die(2, `usage: arc-ux <ask-text|ask-choice|ask-confirm|notify|show-artifact> [flags]`);
}
