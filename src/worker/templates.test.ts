import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSystemPrompt, resolveTemplate } from "./templates";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TEMPLATE_COMBOS: Array<[string, string]> = [
  ["task", "interactive"],
  ["task", "HITL"],
  ["task", "cron"],
  ["task", "mvp"],
  ["task", "security"],
  ["task", "quality"],
  ["task", "scale"],
  ["task", "efficiency"],
  ["task", "deferred"],
  ["event", "interactive"],
  ["reply", "interactive"],
  ["prefetch", "interactive"],
  ["prd", "mvp"],
  ["task", "__unknown__"],
];

const EXTERNAL_SKILLS = new Set(["grill-with-docs", "choose-wisely"]);

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

describe("opening_skills resolve to skills/<name>/SKILL.md", () => {
  for (const [kind, type] of TEMPLATE_COMBOS) {
    it(`${kind}/${type}: every opening skill has a SKILL.md or is external`, () => {
      const t = resolveTemplate(kind, type);
      for (const name of t.opening_skills) {
        if (EXTERNAL_SKILLS.has(name)) continue;
        const path = join(REPO_ROOT, "skills", name, "SKILL.md");
        if (!existsSync(path)) {
          throw new Error(`opening skill "${name}" referenced by ${kind}/${type} missing at ${path}`);
        }
      }
    });
  }
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
