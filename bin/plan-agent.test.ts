import { test, expect } from "bun:test";
import { buildPlanningPrompt, parsePlanJson, planToPlanArgs, serializeObjective, ARCH_CONTEXT, groundingFor } from "./plan-agent";

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

// --- slice B: planner-writes-inferred ---
// The planner may propose ONE candidate mission objective (M-0010 ```objectives``` row)
// alongside the PRD. serializeObjective turns the proposed fields into the exact fence
// line arc-webui's parseObjectives reads, with provenance HARD-CODED to "inferred" — the
// safety invariant (agents propose inferred; only a human promotes to user-directed) is
// enforced at THIS writer, not left to the reader's default.

test("serializeObjective emits a machine-valid M-0010 fence line, provenance hard-coded inferred", () => {
  const line = serializeObjective({ goal: "Cut p95 latency", metric: "p95_ms", gate: "100-300" });
  // one `- ` row, pipe-separated key:value pairs, in the order parseObjectives splits on
  expect(line).toBe("- goal: Cut p95 latency | provenance: inferred | metric: p95_ms | gate: 100-300");
});

test("serializeObjective can NOT emit user-directed — provenance is not a caller-settable field", () => {
  // even if a caller smuggles a provenance/user-directed field, the writer pins inferred.
  const line = serializeObjective({ goal: "g", provenance: "user-directed", metric: "m", gate: "1-2" } as any);
  expect(line).toContain("provenance: inferred");
  expect(line).not.toContain("user-directed");
});

test("serializeObjective omits absent metric/gate (both optional in M-0010)", () => {
  expect(serializeObjective({ goal: "just a goal" })).toBe("- goal: just a goal | provenance: inferred");
});

test("serializeObjective strips pipes/newlines from fields so one objective stays one line", () => {
  // a `|` or newline in a value would corrupt the pipe-split / one-row-per-line contract.
  const line = serializeObjective({ goal: "a | b\nc", metric: "m|x", gate: "1-2" });
  expect(line.split("\n").length).toBe(1);
  // the goal's internal pipe is neutralised, but the field SEPARATORS remain
  expect(line.startsWith("- goal: ")).toBe(true);
  expect(line).toContain(" | provenance: inferred | ");
  expect(line).toContain(" | metric: ");
});

test("parsePlanJson carries a well-formed objective through, ignores a malformed one", () => {
  const withObj = parsePlanJson(JSON.stringify({
    title: "T", body_md: "B", tracers: ["s"],
    objective: { goal: "reduce cost", metric: "usd_per_run", gate: "0-5" },
  }));
  expect(withObj?.objective).toEqual({ goal: "reduce cost", metric: "usd_per_run", gate: "0-5" });
  // a goal-less objective is not a proposal → dropped, plan still valid
  const badObj = parsePlanJson(JSON.stringify({
    title: "T", body_md: "B", tracers: ["s"], objective: { metric: "x" },
  }));
  expect(badObj?.title).toBe("T");
  expect(badObj?.objective).toBeUndefined();
  // no objective key at all → undefined, plan still valid
  const noObj = parsePlanJson(JSON.stringify({ title: "T", body_md: "B", tracers: ["s"] }));
  expect(noObj?.objective).toBeUndefined();
});

test("planToPlanArgs appends the proposed objective as a labelled fence in --body", () => {
  const argv = planToPlanArgs(
    { title: "T", body_md: "PRD BODY", tracers: ["s1"], objective: { goal: "cut cost", metric: "usd", gate: "0-5" } },
    "arc-webui", "t-abc",
  );
  const body = argv[argv.indexOf("--body") + 1]!;
  expect(body).toContain("PRD BODY"); // original PRD preserved
  expect(body).toContain("```objectives"); // a real fenced block the reader can parse
  expect(body).toContain("- goal: cut cost | provenance: inferred | metric: usd | gate: 0-5");
  expect(body.toLowerCase()).toContain("inferred"); // provenance visible to the human reviewer
  // labelled as a proposal a human must promote — not an applied change
  expect(body.toLowerCase()).toMatch(/propos|promote|human/);
});

test("planToPlanArgs leaves --body untouched when no objective is proposed", () => {
  const argv = planToPlanArgs({ title: "T", body_md: "PRD BODY", tracers: ["s1"] }, "arc-webui", "t-abc");
  const body = argv[argv.indexOf("--body") + 1]!;
  expect(body).toBe("PRD BODY");
  expect(body).not.toContain("```objectives");
});

test("buildPlanningPrompt invites an optional candidate objective without forcing one", () => {
  const p = buildPlanningPrompt("Add a dark-mode toggle", "CTX");
  expect(p.toLowerCase()).toContain("objective"); // asks for a candidate objective
  expect(p).not.toContain("```"); // still no hang trigger
});
