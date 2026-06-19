// UX Module Contract — config loader + bookie HITL validator.
// See ADR 0002 (U-0001, U-0005). Config declares verbs + render strategies;
// ledger heartbeats hold liveness. This module is the join point.

import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { hitlKind, type HitlKind } from "./hitl-schemas";
import type { ValidationError } from "./bookie-validator";

/**
 * Resolve ARC_VAULT_HOME following XDG Base Directory Specification.
 *
 * Resolution order (first non-empty wins):
 *   1. $ARC_VAULT_HOME  (explicit override, per-project)
 *   2. $XDG_DATA_HOME/arc/vault  (XDG_DATA_HOME defaults to ~/.local/share)
 *   3. ~/.local/share/arc/vault
 *   4. ~/vault  (legacy fallback — preserves existing installations)
 *
 * Rationale: vault content (notes, evidence, run data) belongs in XDG_DATA_HOME,
 * not mixed with config (XDG_CONFIG_HOME) or runtime/cache (XDG_CACHE_HOME).
 *
 * Cross-repo convention (I-0012):
 *   arc-agents   → ARC_VAULT_HOME / XDG_DATA_HOME/arc/vault
 *   ke           → KE_VAULT_HOME  / XDG_DATA_HOME/ke/vault
 *   pipeliner    → PIPELINER_VAULT_HOME / XDG_DATA_HOME/pipeliner/vault
 *   cli-proxy    → CLI_PROXY_VAULT_HOME / XDG_DATA_HOME/cli-proxy/vault
 */
export function resolveVaultHome(): string {
  const home = homedir();
  if (process.env.ARC_VAULT_HOME) return process.env.ARC_VAULT_HOME;
  const xdg = process.env.XDG_DATA_HOME ?? `${home}/.local/share`;
  const xdgVault = `${xdg}/arc/vault`;
  if (existsSync(xdgVault)) return xdgVault; // early exit if XDG path already populated
  const legacy = `${home}/vault`;
  if (existsSync(legacy) && !existsSync(xdgVault)) return legacy; // prefer existing legacy
  return xdgVault;
}

/**
 * Resolve the ledger SQLite path.
 *
 * Resolution order:
 *   1. $ARC_LEDGER_DB   (explicit override — full path)
 *   2. resolveVaultHome()/ledger.db
 *   3. ~/vault/ledger.db  (legacy fallback)
 *
 * Note: the legacy fallback is intentionally the last resort, not the default.
 * Existing installations without XDG migration will silently get ~/vault/ledger.db
 * only when neither ARC_LEDGER_DB nor ARC_VAULT_HOME is set and neither the
 * XDG path nor the legacy path exists — meaning first-run uses the XDG path.
 */
export function resolveLedgerDb(): string {
  if (process.env.ARC_LEDGER_DB) return process.env.ARC_LEDGER_DB;
  const vaultHome = resolveVaultHome();
  return `${vaultHome}/ledger.db`;
}


const RENDER_STRATEGY = z.enum([
  "native",
  "rasterize-png",
  "ascii-degrade",
  "link-out",
  "unsupported",
]);
export type RenderStrategy = z.infer<typeof RENDER_STRATEGY>;

const ARTIFACT_TYPE = z.enum([
  "text/markdown",
  "text/diff",
  "chart/vega-lite",
  "diagram/mermaid",
  "image/png",
  "table/rows",
]);
export type ArtifactType = z.infer<typeof ARTIFACT_TYPE>;

const moduleSchema = z.object({
  cli: z.string().optional(),
  pusher: z.string().optional(),
  implements: z.array(hitlKind).default([]),
  renders: z.record(z.string(), RENDER_STRATEGY).default({}),
  can_retract: z.boolean().default(false),
});
export type UxModule = z.infer<typeof moduleSchema> & { name: string };

const configSchema = z.object({
  modules: z.record(z.string(), moduleSchema).default({}),
});
export type UxConfig = z.infer<typeof configSchema>;

export function defaultConfigPath(): string {
  if (process.env.ARC_CONFIG) return process.env.ARC_CONFIG;
  const home = process.env.HOME ?? "";
  return `${home}/.config/arc/config.yaml`;
}

export function loadConfig(path: string = defaultConfigPath()): UxConfig {
  if (!existsSync(path)) return { modules: {} };
  const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  return configSchema.parse(raw);
}

const STALE_SEC = 300;

export function aliveModuleNames(db: Database, staleSec = STALE_SEC): string[] {
  const cutoff = Math.floor(Date.now() / 1000) - staleSec;
  return db
    .query<{ module_name: string }, [number]>(
      "SELECT module_name FROM ux_heartbeats WHERE last_beat > ?",
    )
    .all(cutoff)
    .map((r) => r.module_name);
}

export function pickModulesForHitl(db: Database, cfg: UxConfig, kind: HitlKind): UxModule[] {
  const alive = new Set(aliveModuleNames(db));
  const out: UxModule[] = [];
  for (const [name, mod] of Object.entries(cfg.modules)) {
    if (!alive.has(name)) continue;
    if (!mod.implements.includes(kind)) continue;
    out.push({ ...mod, name });
  }
  return out;
}

export type HitlWriteInput = {
  kind: HitlKind;
  artifacts?: { type: string }[];
};

// A render strategy "renders" the artifact if it's not 'unsupported' and not missing.
function rendersArtifact(mod: UxModule, type: string): boolean {
  const s = mod.renders[type as ArtifactType];
  return s !== undefined && s !== "unsupported";
}

export function validateHitlWrite(
  db: Database,
  cfg: UxConfig,
  input: HitlWriteInput,
): ValidationError[] {
  const errs: ValidationError[] = [];
  const candidates = pickModulesForHitl(db, cfg, input.kind);
  if (candidates.length === 0) {
    errs.push({
      field: "kind",
      message: `no alive UX module implements '${input.kind}'. Install or revive one (ADR 0002).`,
    });
    return errs;
  }
  for (const art of input.artifacts ?? []) {
    const anyRenders = candidates.some((m) => rendersArtifact(m, art.type));
    if (!anyRenders) {
      errs.push({
        field: "artifacts",
        message: `no alive module renders artifact type '${art.type}' for verb '${input.kind}'`,
      });
    }
  }
  return errs;
}
