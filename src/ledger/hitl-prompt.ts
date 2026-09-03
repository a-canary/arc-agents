// Consolidated HITL prompt build + insert path.
// See ADR 0002 — UX Module Contract.
//
// Both bin/arc-ux.ts (the UX verb shim) and bin/ledger.ts `hitl emit` route
// through this module so:
//   1. payload shape is validated via Zod (parsePayload from hitl-schemas.ts)
//   2. pre-write checks (alive-module + render-capability) run before INSERT
//   3. row + per-module hitl_deliveries inserts happen atomically in one tx
//
// Prior to this module, `bin/ledger.ts hitl emit` constructed `payload` as a
// plain object literal in a switch(kind) and inserted directly via SQL —
// silently bypassing parsePayload. arc-ux validated correctly; ledger did not.
// Now there is one validated insert path.

import type { Database } from "bun:sqlite";
import { parsePayload, type HitlKind } from "./hitl-schemas";
import { pickModulesForHitl, validateHitlWrite, type UxConfig } from "./ux-config";

// --- buildPayload --------------------------------------------------------

export type BuildPayloadArgs = {
  prompt?: string;
  options?: string[];
  message?: string;
  level?: "info" | "warn" | "error";
  caption?: string;
  artifacts?: { type: string; inline?: string; path?: string }[];
};

// ValidatedPayload is the parsed Zod output for `kind`. We keep it as
// `unknown` at the type boundary so callers must treat it as opaque JSON;
// the schema CHECK and consumer code reads the persisted string back.
export type ValidatedPayload = unknown;

/**
 * Construct the per-kind payload shape from CLI-style args, then validate it
 * via parsePayload (Zod). Throws ZodError on invalid input — callers should
 * surface the message to stderr and exit non-zero.
 */
export function buildPayload(kind: HitlKind, args: BuildPayloadArgs): ValidatedPayload {
  let raw: unknown;
  switch (kind) {
    case "ask_text":
      raw = { prompt: args.prompt, artifacts: args.artifacts ?? [] };
      break;
    case "ask_choice":
      raw = {
        prompt: args.prompt,
        options: args.options ?? [],
        artifacts: args.artifacts ?? [],
      };
      break;
    case "ask_confirm":
      raw = { prompt: args.prompt, artifacts: args.artifacts ?? [] };
      break;
    case "notify":
      raw = { message: args.message, level: args.level ?? "info" };
      break;
    case "show_artifact":
      raw = { caption: args.caption, artifacts: args.artifacts ?? [] };
      break;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unsupported HITL kind: ${String(_exhaustive)}`);
    }
  }
  return parsePayload(kind, raw);
}

// --- insertHitlPrompt ----------------------------------------------------

export type InsertHitlPromptInput = {
  /** Optional id (deterministic for tests); defaults to a fresh UUID. */
  id?: string;
  kind: HitlKind;
  cls: "taste" | "impact";
  /** Already-validated payload from buildPayload(). */
  payload: ValidatedPayload;
  recommended: string | null;
  strategy: "forward_fix" | "replay" | null;
  timeoutSec: number | null;
  // All three anchor fields are optional individually (e.g. `ledger hitl
   // emit --anchor-repo foo` may omit branch/commit). When omitted the
   // hitl_prompts row stores NULL for the missing components.
  anchor?: { repo?: string | null; branch?: string | null; commit?: string | null } | null;
  emittedBy?: string | null;
  cfg: UxConfig;
};

export type InsertHitlPromptResult = {
  id: string;
  deliveries: string[];
  /** True when the row was persisted with no live module to deliver it to. */
  undelivered: boolean;
};

function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Bookie pre-write checks (alive-module + render-capability) + atomic insert
 * of the hitl_prompts row and one hitl_deliveries row per alive module.
 *
 * Dead-surface fallback: when no alive module implements the verb the row is
 * STILL persisted, with zero deliveries and undelivered=true. Losing the ask
 * outright is worse than parking it — a later-revived module (or the operator
 * reading hitl_prompts directly) can still find it. Callers surface the
 * undelivered flag loudly; they no longer abort.
 */
export function insertHitlPrompt(
  db: Database,
  input: InsertHitlPromptInput,
): InsertHitlPromptResult {
  const artifactTypes =
    ((input.payload as { artifacts?: { type: string }[] }).artifacts ?? []).map((a) => a.type);

  const modules = pickModulesForHitl(db, input.cfg, input.kind);
  const undelivered = modules.length === 0;

  // Render-capability errors still hard-fail, but only when there IS a live
  // surface to render on — otherwise the dead-surface fallback owns the case.
  if (!undelivered) {
    const errs = validateHitlWrite(db, input.cfg, {
      kind: input.kind,
      artifacts: artifactTypes.map((t) => ({ type: t })),
    });
    if (errs.length > 0) {
      throw new Error(errs.map((e) => `${e.field}: ${e.message}`).join("; "));
    }
  }

  const id = input.id ?? uuid();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = input.timeoutSec ? now + input.timeoutSec : null;

  db.transaction(() => {
    db.run(
      `INSERT INTO hitl_prompts
         (id, kind, class, payload, recommended, divergence_strategy, timeout_sec,
          state, anchor_repo, anchor_branch, anchor_commit, expires_at, emitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.cls,
        JSON.stringify(input.payload),
        input.recommended,
        input.strategy,
        input.timeoutSec,
        input.anchor?.repo ?? null,
        input.anchor?.branch ?? null,
        input.anchor?.commit ?? null,
        expiresAt,
        input.emittedBy ?? null,
      ],
    );
    for (const m of modules) {
      db.run(
        `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES (?, ?, 'pending')`,
        [id, m.name],
      );
    }
  })();

  return { id, deliveries: modules.map((m) => m.name), undelivered };
}
