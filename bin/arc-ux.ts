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
import { parsePayload, type HitlKind } from "../src/ledger/hitl-schemas";
import { loadConfig, pickModulesForHitl, validateHitlWrite } from "../src/ledger/ux-config";

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

function uuid(): string {
  // 16 random bytes, formatted as 8-4-4-4-12 hex. Cheap and dependency-free.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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

type AliveModule = { name: string; implements: string[]; can_retract: boolean };

function bootstrapTaskIfNeeded(reason: string): void {
  // Atomically spawn an install/repair task via the `ledger` CLI. The bookie
  // is the canonical write path; we shell out instead of duplicating its
  // validation here. Idempotency: we use a deterministic slug, so re-runs
  // collide on PK and become no-ops.
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

function pickModulesFor(kind: HitlKind, artifactTypes: string[] = []): AliveModule[] {
  const db = open();
  const cfg = loadConfig();
  const errs = validateHitlWrite(db, cfg, {
    kind,
    artifacts: artifactTypes.map((t) => ({ type: t })),
  });
  if (errs.length > 0) {
    // Surface the first error to stderr so the caller sees *why*.
    process.stderr.write(`arc-ux: ${errs.map((e) => `${e.field}: ${e.message}`).join("; ")}\n`);
    return [];
  }
  return pickModulesForHitl(db, cfg, kind).map((m) => ({
    name: m.name,
    implements: m.implements,
    can_retract: m.can_retract,
  }));
}

function insertPromptAndDeliveries(opts: {
  id: string;
  kind: HitlKind;
  cls: "taste" | "impact";
  payload: unknown;
  recommended: string | null;
  strategy: "forward_fix" | "replay" | null;
  timeoutSec: number | null;
  anchor: { repo: string; branch: string; commit: string } | null;
  modules: AliveModule[];
}): void {
  const db = open();
  migrate(db);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = opts.timeoutSec ? now + opts.timeoutSec : null;
  db.transaction(() => {
    db.run(
      `INSERT INTO hitl_prompts
         (id, kind, class, payload, recommended, divergence_strategy, timeout_sec,
          state, anchor_repo, anchor_branch, anchor_commit, expires_at, emitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      [
        opts.id,
        opts.kind,
        opts.cls,
        JSON.stringify(opts.payload),
        opts.recommended,
        opts.strategy,
        opts.timeoutSec,
        opts.anchor?.repo ?? null,
        opts.anchor?.branch ?? null,
        opts.anchor?.commit ?? null,
        expiresAt,
        process.env.ARC_ROLE ?? null,
      ],
    );
    for (const m of opts.modules) {
      db.run(
        `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES (?, ?, 'pending')`,
        [opts.id, m.name],
      );
    }
  })();
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

  // Validate payload shape.
  parsePayload(kind, payload);

  const artifactTypes = ((payload as { artifacts?: { type: string }[] }).artifacts ?? []).map((a) => a.type);
  const modules = pickModulesFor(kind, artifactTypes);
  if (modules.length === 0) {
    bootstrapTaskIfNeeded(`no alive module implements ${kind}`);
    die(3, `no alive UX module implements ${kind}; bootstrap task spawned`);
  }

  const id = uuid();
  const anchor = cls === "taste" ? gitAnchor() : null;
  insertPromptAndDeliveries({
    id,
    kind,
    cls,
    payload,
    recommended,
    strategy,
    timeoutSec,
    anchor,
    modules,
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
    const payload = { message, level };
    parsePayload("notify", payload);
    const modules = pickModulesFor("notify");
    if (modules.length === 0) {
      bootstrapTaskIfNeeded("no alive module implements notify");
      die(3, "no alive UX module implements notify; bootstrap task spawned");
    }
    const id = uuid();
    // notify is broadcast, never claimed, never waited on. Same row machinery,
    // but state goes straight to 'answered' once any module acks — or we leave
    // it 'open' with a short expires_at and let the reconciler reap it.
    insertPromptAndDeliveries({
      id,
      kind: "notify",
      cls: "taste",
      payload,
      recommended: "(notify)",
      strategy: null,
      timeoutSec: 3600,
      anchor: null,
      modules,
    });
    process.stdout.write(JSON.stringify({ id, broadcast: modules.map((m) => m.name) }) + "\n");
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
