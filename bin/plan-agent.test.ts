import { test, expect } from "bun:test";
import { buildPlanningPrompt, parsePlanJson, planToPlanArgs, ARCH_CONTEXT, groundingFor } from "./plan-agent";

test("buildPlanningPrompt embeds request + context, asks for the json shape, avoids the hang trigger", () => {
  const p = buildPlanningPrompt("Add a dark-mode toggle", "PROJECT: arc-webui is server-rendered.");
  expect(p).toContain("Add a dark-mode toggle");
  expect(p).toContain("server-rendered");
  expect(p).toContain("title");
  expect(p).toContain("body_md");
  expect(p).toContain("tracers");
  // hang trigger (proven by experiment): a literal json template / code fence in the
  // prompt makes headless MiniMax loop to timeout. The prompt must contain neither.
  expect(p).not.toContain("```");
  expect(p).not.toContain('{"title"');
});

test("buildPlanningPrompt drives real repo research (CONTEXT.md + ADRs) and asks for user stories", () => {
  const p = buildPlanningPrompt("Add a dark-mode toggle", "PROJECT: arc-webui is server-rendered.");
  // the regression was a blind no-research single-shot. The prompt must now tell the
  // agent to ground itself in the actual repo before planning.
  expect(p).toContain("CONTEXT.md");
  expect(p.toLowerCase()).toContain("docs/adr");
  // the good PRDs carry an extensive user-story list — the prompt must demand one.
  expect(p).toContain("User Stories");
  // still fence-free (no hang trigger, harmless under any engine) and still names the keys.
  expect(p).not.toContain("```");
  expect(p).toContain("body_md");
});

test("parsePlanJson reads a clean object", () => {
  const out = JSON.stringify({ title: "Dark mode", body_md: "## Problem\nx", tracers: ["a", "b"] });
  const plan = parsePlanJson(out);
  expect(plan?.title).toBe("Dark mode");
  expect(plan?.tracers).toEqual(["a", "b"]);
});

test("parsePlanJson strips a json fence the model may emit despite instructions", () => {
  const fence = "```";
  const out = "Here you go:\n" + fence + "json\n" + JSON.stringify({ title: "T", body_md: "B", tracers: ["s1"] }) + "\n" + fence + "\n";
  const plan = parsePlanJson(out);
  expect(plan?.title).toBe("T");
  expect(plan?.tracers).toEqual(["s1"]);
});

test("parsePlanJson returns null on garbage, missing keys, or empty tracers", () => {
  expect(parsePlanJson("not json at all")).toBeNull();
  expect(parsePlanJson(JSON.stringify({ title: "T", body_md: "B" }))).toBeNull();
  expect(parsePlanJson(JSON.stringify({ title: "T", body_md: "B", tracers: [] }))).toBeNull();
  expect(parsePlanJson(JSON.stringify({ body_md: "B", tracers: ["s"] }))).toBeNull();
});

// No bare-request fallback: on an unparseable/failed engine run parsePlanJson returns
// null and main() exits non-zero rather than minting the prompt as a PRD. The null
// contract is covered by "parsePlanJson returns null on garbage" above.

test("planToPlanArgs maps a plan to plan.ts argv, one --tracer per slice, title clamped", () => {
  const argv = planToPlanArgs(
    { title: "y".repeat(200), body_md: "BODY", tracers: ["s1", "s2"] },
    "arc-webui",
    "t-abc",
  );
  const flag = (n: string) => argv[argv.indexOf("--" + n) + 1];
  expect(flag("project")).toBe("arc-webui");
  expect(flag("thread")).toBe("t-abc");
  expect(flag("body")).toBe("BODY");
  expect(flag("title")!.length).toBeLessThanOrEqual(80);
  expect(argv.filter((a) => a === "--tracer").length).toBe(2);
});

test("ARCH_CONTEXT names the arc-webui architecture so plans respect the no-build-step constraint", () => {
  expect(ARCH_CONTEXT).toContain("arc-webui");
  expect(ARCH_CONTEXT.toLowerCase()).toContain("server-render");
});

test("buildPlanningPrompt frames the prompt for the named project, not always arc-webui", () => {
  const p = buildPlanningPrompt("merge two modules", "CTX", "expert-horde");
  expect(p).toContain("expert-horde project");
  expect(p).not.toContain("arc-webui project");
});

test("groundingFor falls back to ARCH_CONTEXT for arc-webui (no repo CONTEXT.md)", () => {
  expect(groundingFor("arc-webui")).toBe(ARCH_CONTEXT);
});

test("groundingFor reads the target repo's CONTEXT.md glossary when present", () => {
  const g = groundingFor("expert-horde");
  expect(g).toContain("expert-horde"); // labelled with the project
  expect(g.toLowerCase()).toContain("horde"); // pulled from the real glossary
});

test("groundingFor gives a neutral reversible-first context for an unknown project", () => {
  const g = groundingFor("nonesuch-xyz-123");
  expect(g).toContain("nonesuch-xyz-123");
  expect(g.toLowerCase()).toContain("reversible");
});
