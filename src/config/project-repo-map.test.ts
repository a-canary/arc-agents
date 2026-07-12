import { expect, test } from "bun:test";
import { isParkedProject, loadProjectRepoMap, resolveProjectRepo } from "./project-repo-map";

test("loadProjectRepoMap reads the real shared map", () => {
  const map = loadProjectRepoMap();
  expect(map["starlight-slm"]?.parked).toBe(true);
  expect(map["local-models"]?.parked).toBe(true);
});

test("resolveProjectRepo: mapped project with a repo key expands ~/", () => {
  expect(resolveProjectRepo("cli-proxy")).toBe(`${process.env.HOME}/repos/cli-proxy`);
});

test("resolveProjectRepo: starlight-slm is parked but still routable (has a repo key)", () => {
  expect(resolveProjectRepo("starlight-slm")).toBe(`${process.env.HOME}/repos/starlight-slm`);
});

test("resolveProjectRepo: local-models is parked with no repo key → null", () => {
  expect(resolveProjectRepo("local-models")).toBeNull();
});

test("resolveProjectRepo: env override beats the shared map", () => {
  process.env.ARC_PROJECT_REPO_CLI_PROXY = "/override/cli-proxy";
  try {
    expect(resolveProjectRepo("cli-proxy")).toBe("/override/cli-proxy");
  } finally {
    delete process.env.ARC_PROJECT_REPO_CLI_PROXY;
  }
});

test("isParkedProject: true for starlight-slm and local-models, false otherwise", () => {
  expect(isParkedProject("starlight-slm")).toBe(true);
  expect(isParkedProject("local-models")).toBe(true);
  expect(isParkedProject("cli-proxy")).toBe(false);
  expect(isParkedProject("nonexistent-project")).toBe(false);
});
