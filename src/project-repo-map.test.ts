import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  PARKED_PROJECTS,
  PROJECT_REPO_MAP,
  isParkedProject,
} from "./project-repo-map";

function bashLookup(project: string): string {
  const script = join(import.meta.dir, "project-repo-map.sh");
  const result = spawnSync(
    "bash",
    ["-c", `source "$0" && project_repo_map_lookup "$1"`, script, project],
    { encoding: "utf8" },
  );
  return result.stdout.trim();
}

function bashIsParked(project: string): string {
  const script = join(import.meta.dir, "project-repo-map.sh");
  const result = spawnSync(
    "bash",
    ["-c", `source "$0" && is_parked_project "$1" && echo parked || echo open`, script, project],
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

describe("parked-lane spend-gate", () => {
  test("starlight-slm and local-models are parked", () => {
    expect(isParkedProject("starlight-slm")).toBe(true);
    expect(isParkedProject("local-models")).toBe(true);
  });

  test("non-parked project is open", () => {
    expect(isParkedProject("arc-agents")).toBe(false);
    expect(isParkedProject("starlight")).toBe(false);
  });

  test("ts and bash agree on parked set", () => {
    for (const project of PARKED_PROJECTS) {
      expect(bashIsParked(project)).toBe("parked");
    }
    expect(bashIsParked("arc-agents")).toBe("open");
    expect(bashIsParked("starlight")).toBe("open");
  });
});
