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

  it("task/mvp includes triage-failed", () => {
    expect(resolveTemplate("task", "mvp").opening_skills).toContain("triage-failed");
  });
});

describe("renderSystemPrompt", () => {
  const base = { worker: "arc-worker-i-abc", task: "i-xyz" };

  it("includes caveman + bookie + author overlays", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", type: "interactive" });
    expect(p).toContain("Reply terse");
    expect(p).toContain("bookie subagent");
    expect(p).toContain("git config user.name");
  });

  it("never hardcodes a username", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", type: "mvp" });
    expect(p).not.toContain("a-canary");
    expect(p).not.toContain("aaron");
  });

  it("leading line carries kind+type+worker+task", () => {
    const p = renderSystemPrompt({ ...base, kind: "event", type: "interactive" });
    expect(p.split("\n")[0]).toContain("kind=event");
    expect(p.split("\n")[0]).toContain("type=interactive");
    expect(p.split("\n")[0]).toContain("worker=arc-worker-i-abc");
    expect(p.split("\n")[0]).toContain("task=i-xyz");
  });

  it("opening-skills line omitted when none", () => {
    const p = renderSystemPrompt({ ...base, kind: "reply", type: "interactive" });
    expect(p).not.toContain("Opening skills");
  });

  it("opening-skills line present when configured", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", type: "mvp" });
    expect(p).toContain("Opening skills");
    expect(p).toContain("/ke-recall");
    expect(p).toContain("/triage-failed");
  });

  it("includes AGENTS.md doctrine (Evidence-First, Concern, Pattern)", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", type: "mvp" });
    expect(p).toContain("Evidence-First");
    expect(p).toContain("HITL Decomposition");
    expect(p).toContain("Pattern Detection");
  });
});
