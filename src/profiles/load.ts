import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ProfileSchema = z.object({
  role: z.string(),
  context_summary: z.string(),
  boot_skills: z.array(z.string()),
  stop_skills: z.array(z.string()),
  model: z.string(),
  thinking: z.enum(["off", "on"]),
  effort: z.enum(["low", "med", "max"]),
  daily_budget_usd: z.number().positive(),
  speculative_budget: z.number().nonnegative(),
  max_concurrency: z.number().int().positive(),
  worktree: z.boolean(),
});

export type Profile = z.infer<typeof ProfileSchema>;

const repoRoot = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadProfile(role: string, root: string = repoRoot()): Profile {
  const path = join(root, "profiles", `${role}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ProfileSchema.parse(raw);
}

export function loadAll(root: string = repoRoot()): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  for (const role of ["developer", "director", "admin"]) {
    out[role] = loadProfile(role, root);
  }
  return out;
}
