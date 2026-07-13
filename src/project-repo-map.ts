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
};

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
