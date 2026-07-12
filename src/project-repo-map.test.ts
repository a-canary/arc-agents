import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PROJECT_REPO_MAP } from "./project-repo-map";

function bashLookup(project: string): string {
  const script = join(import.meta.dir, "project-repo-map.sh");
  const result = spawnSync(
    "bash",
    ["-c", `source "$0" && project_repo_map_lookup "$1"`, script, project],
    { encoding: "utf8" },
  );
  return result.stdout.trim();
}

describe("project-repo-map parity (ts vs bash)", () => {
  for (const [project, repoDir] of Object.entries(PROJECT_REPO_MAP)) {
    test(`${project} agrees`, () => {
      expect(bashLookup(project)).toBe(repoDir);
    });
  }

  test("unmapped project yields empty string in bash", () => {
    expect(bashLookup("allmissions")).toBe("");
    expect(PROJECT_REPO_MAP["allmissions"]).toBeUndefined();
  });
});
