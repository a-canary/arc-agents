// Shared project -> repo-dir-name map, consulted by both plan-agent's
// resolveProjectRepo (TS) and worker-shell's resolve_repo (bash, via
// project-repo-map.sh below). Precedence (enforced by each caller):
// env override -> this map -> ~/repos/<project> -> null.
//
// List every known project explicitly, even where dir name == project name
// (e.g. starlight-slm), so this map is the one place that enumerates them.
export const PROJECT_REPO_MAP: Record<string, string> = {
  starlight: "expert-horde",
  "starlight-slm": "starlight-slm",
  onenation: "OneNation",
  // Nested, non-conventional: repo is ~/repos/RRDM/rrdm, not ~/repos/rrdm.
  rrdm: "RRDM/rrdm",
};

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolve a project's local repo directory to an absolute path.
// Precedence: ARC_PROJECT_REPO_<UPPER> env override -> this map -> project
// name -> ~/repos/<repoDir>. Returns null if no candidate exists on disk;
// callers (defaultRunner) fall back to process.cwd() in that case.
export function resolveProjectRepo(project: string | null | undefined): string | null {
  if (!project) return null;
  const override = process.env[`ARC_PROJECT_REPO_${project.toUpperCase().replace(/-/g, "_")}`];
  if (override) return override;
  const repoDir = PROJECT_REPO_MAP[project] ?? project;
  const candidate = join(homedir(), "repos", repoDir);
  return existsSync(candidate) ? candidate : null;
}

// Parked lanes: GPU-spend projects gated behind hitl/spend_gate. A task in a
// parked project must carry the spend-gate marker before worker-shell will let
// it invoke GPU tools. Keep this set in parity with is_parked_project below.
export const PARKED_PROJECTS: ReadonlySet<string> = new Set([
  "starlight-slm",
  "local-models",
]);

export function isParkedProject(project: string): boolean {
  return PARKED_PROJECTS.has(project);
}
