import { describe, expect, it } from "bun:test";
import { renderSystemPrompt, resolveTemplate } from "./templates";

describe("resolveTemplate", () => {
  it("picks interactive frame for reply/interactive", () => {
    expect(resolveTemplate("reply", "interactive").frame).toBe("interactive");
  });

  it("picks intake frame for event/interactive with grill+choose skills", () => {
    const t = resolveTemplate("event", "interactive");
    expect(t.frame).toBe("intake");
    expect(t.opening_skills).toContain("grill-with-docs");
    expect(t.opening_skills).toContain("choose-wisely");
  });

  it("falls back to afk default for unknown combos", () => {
    const t = resolveTemplate("task", "wat-is-this");
    expect(t.frame).toBe("afk");
    expect(t.opening_skills).toEqual(["ke-recall"]);
  });

  it("task/nominal includes triage-failed", () => {
    expect(resolveTemplate("task", "nominal").opening_skills).toContain("triage-failed");
  });

  it("task with hitl=1 routes to HITL template (afk + to-ledger)", () => {
    const t = resolveTemplate("task", "nominal", 1);
    expect(t.frame).toBe("afk");
    expect(t.opening_skills).toContain("to-ledger");
  });
});

describe("renderSystemPrompt", () => {
  const base = { worker: "arc-worker-i-abc", task: "i-xyz" };

  it("includes caveman + bookie + author overlays", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", urgency: "interactive" });
    expect(p).toContain("Reply terse");
    expect(p).toContain("bookie subagent");
    expect(p).toContain("git config user.name");
  });

  it("never hardcodes a username", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", urgency: "nominal" });
    expect(p).not.toContain("a-canary");
    expect(p).not.toContain("aaron");
  });

  it("leading line carries kind+urgency+hitl+worker+task", () => {
    const p = renderSystemPrompt({ ...base, kind: "event", urgency: "interactive" });
    expect(p.split("\n")[0]).toContain("kind=event");
    expect(p.split("\n")[0]).toContain("urgency=interactive");
    expect(p.split("\n")[0]).toContain("hitl=0");
    expect(p.split("\n")[0]).toContain("worker=arc-worker-i-abc");
    expect(p.split("\n")[0]).toContain("task=i-xyz");
  });

  it("opening-skills line omitted when none", () => {
    const p = renderSystemPrompt({ ...base, kind: "reply", urgency: "interactive" });
    expect(p).not.toContain("Opening skills");
  });

  it("opening-skills line present when configured", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", urgency: "nominal" });
    expect(p).toContain("Opening skills");
    expect(p).toContain("/ke-recall");
    expect(p).toContain("/triage-failed");
  });

  it("includes AGENTS.md doctrine (Evidence-First, Concern, Pattern)", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", urgency: "nominal" });
    expect(p).toContain("Evidence-First");
    expect(p).toContain("HITL Decomposition");
    expect(p).toContain("Pattern Detection");
  });
});
