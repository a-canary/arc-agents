import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSystemPrompt, resolveTemplate } from "./templates";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// All real agent keys from AGENT_TABLE + DEFAULT (via "nope")
const AGENT_COMBOS: Array<[string, string]> = [
  ["developer", "build"],
  ["developer", "interactive"],
  ["developer", "ops"],
  ["director", "interactive"],
  ["director", "build"],
  ["admin", "build"],
  ["chat", "interactive"],
  ["triage", "explore"],
  ["sprint", "build"],
  ["sprint", "interactive"],
  ["bookie", "build"],
  ["agent_unset", "build"],
  ["nope", "build"], // unknown agent → DEFAULT
];

const EXTERNAL_SKILLS = new Set(["grill-with-docs", "choose-wisely", "anti-sycophancy", "install-anti-sycophancy"]);

describe("resolveTemplate (agent-keyed)", () => {
  it("sprint agent → sprint frame regardless of pool", () => {
    expect(resolveTemplate("sprint", "build").frame).toBe("sprint");
    expect(resolveTemplate("sprint", "interactive").frame).toBe("sprint");
  });

  it("sprint opening_skills contains sprint-supervise", () => {
    expect(resolveTemplate("sprint", "build").opening_skills).toContain("sprint-supervise");
  });

  it("director → intake frame with grill+choose skills", () => {
    const t = resolveTemplate("director", "interactive");
    expect(t.frame).toBe("intake");
    expect(t.opening_skills).toContain("grill-with-docs");
    expect(t.opening_skills).toContain("choose-wisely");
  });

  it("chat → intake frame", () => {
    expect(resolveTemplate("chat", "interactive").frame).toBe("intake");
  });

  it("developer + pool=interactive → interactive frame (pool drives human-presence)", () => {
    expect(resolveTemplate("developer", "interactive").frame).toBe("interactive");
  });

  it("developer + pool=build → afk frame", () => {
    expect(resolveTemplate("developer", "build").frame).toBe("afk");
  });

  it("triage + pool=explore → afk frame + triage-assign skill", () => {
    const t = resolveTemplate("triage", "explore");
    expect(t.frame).toBe("afk");
    expect(t.opening_skills).toContain("triage-assign");
  });

  it("unknown agent falls back to afk default with ke-recall only", () => {
    const t = resolveTemplate("nope", "build");
    expect(t.frame).toBe("afk");
    expect(t.opening_skills).toEqual(["ke-recall"]);
  });

  it("sprint overrides pool=interactive: still sprint frame, not interactive", () => {
    expect(resolveTemplate("sprint", "interactive").frame).toBe("sprint");
    expect(resolveTemplate("sprint", "interactive").frame).not.toBe("interactive");
  });
});

describe("opening_skills resolve to skills/<name>/SKILL.md or are external", () => {
  for (const [agent, pool] of AGENT_COMBOS) {
    it(`${agent}/${pool}: every opening skill has a SKILL.md or is external`, () => {
      const t = resolveTemplate(agent, pool);
      for (const name of t.opening_skills) {
        if (EXTERNAL_SKILLS.has(name)) continue;
        const path = join(REPO_ROOT, "skills", name, "SKILL.md");
        if (!existsSync(path)) {
          throw new Error(`opening skill "${name}" referenced by ${agent}/${pool} missing at ${path}`);
        }
      }
    });
  }
});

it("skills/spec-to-tickets/SKILL.md exists", () => {
  expect(existsSync(join(REPO_ROOT, "skills", "spec-to-tickets", "SKILL.md"))).toBe(true);
});

describe("renderSystemPrompt (agent-keyed)", () => {
  const base = { worker: "arc-worker-i-abc", task: "i-xyz" };

  it("includes caveman + bookie + author overlays", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build" });
    expect(p).toContain("Reply terse");
    expect(p).toContain("bookie subagent");
    expect(p).toContain("git config user.name");
  });

  it("never hardcodes a username", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build" });
    // The user identity must not be baked into the commit author. A bare
    // string match for "a-canary" is too coarse — the diff-review overlay
    // (see roles/overlays/diff-review.md) uses "a-canary" as the GitHub
    // owner constant in a bash check, which is legitimate. The actual
    // concern is that the prompt does not instruct the worker to commit
    // as a specific identity.
    expect(p).not.toMatch(/Author:\s*a-canary/i);
    expect(p).not.toMatch(/Co-Authored-By:\s*a-canary/i);
    expect(p).not.toContain("aaron");
  });

  it("leading line carries kind, agent, pool, worker, task", () => {
    const p = renderSystemPrompt({ ...base, kind: "sprint", agent: "sprint", pool: "build" });
    const first = p.split("\n")[0]!;
    expect(first).toContain("kind=sprint");
    expect(first).toContain("agent=sprint");
    expect(first).toContain("pool=build");
    expect(first).toContain("worker=arc-worker-i-abc");
    expect(first).toContain("task=i-xyz");
    // must NOT contain old type= key
    expect(first).not.toContain("type=");
  });

  it("leading line does NOT contain type=", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "ops" });
    expect(p.split("\n")[0]).not.toContain("type=");
  });

  it("opening-skills line present for developer (ke-recall)", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build" });
    expect(p).toContain("Opening skills");
    expect(p).toContain("/ke-recall");
  });

  it("opening-skills line present and contains triage-failed for developer", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build" });
    expect(p).toContain("/triage-failed");
  });

  it("includes AGENTS.md doctrine (Evidence-First, HITL Decomposition, Pattern Detection)", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build" });
    expect(p).toContain("Evidence-First");
    expect(p).toContain("HITL Decomposition");
    expect(p).toContain("Pattern Detection");
  });

  it("## Brief section present when brief provided", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build", brief: "do the thing" });
    expect(p).toContain("## Brief");
    expect(p).toContain("do the thing");
  });

  it("## Brief section absent when brief is not provided", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build" });
    expect(p).not.toContain("## Brief");
  });

  it("## Brief section absent when brief is empty string", () => {
    const p = renderSystemPrompt({ ...base, kind: "task", agent: "developer", pool: "build", brief: "" });
    expect(p).not.toContain("## Brief");
  });

  it("sprint render contains sprint frame distinctive text", () => {
    const p = renderSystemPrompt({ ...base, kind: "sprint", agent: "sprint", pool: "build" });
    expect(p).toContain("re-entrant");
    expect(p).toContain("prior-cycle handoffs");
  });
});

describe("renderSystemPrompt handoff (P1 resume)", () => {
  const base = { worker: "arc-worker-i-abc", task: "i-xyz", kind: "task", agent: "developer", pool: "build" };

  it("renders a Prior work section when handoff is provided", () => {
    const p = renderSystemPrompt({ ...base, handoff: "did step 1; next do step 2" });
    expect(p).toContain("## Prior work — resume from here");
    expect(p).toContain("did step 1; next do step 2");
  });

  it("omits the section when handoff is absent or blank", () => {
    expect(renderSystemPrompt({ ...base })).not.toContain("## Prior work");
    expect(renderSystemPrompt({ ...base, handoff: "   " })).not.toContain("## Prior work");
  });
});

describe("renderSystemPrompt profile skills (P2b: profile is source of truth)", () => {
  const base = { worker: "arc-worker-i-abc", task: "i-xyz", kind: "task", agent: "developer", pool: "build" };

  it("boot_skills override AGENT_TABLE opening skills", () => {
    const p = renderSystemPrompt({ ...base, boot_skills: ["tdd", "coding-standards"] });
    expect(p).toContain("Opening skills (load on first turn): /tdd, /coding-standards.");
    // AGENT_TABLE.developer skill not in the profile must not leak.
    expect(p).not.toContain("/triage-failed");
  });

  it("renders a Closing skills line from stop_skills", () => {
    const p = renderSystemPrompt({ ...base, stop_skills: ["ke-learn", "simplify"] });
    expect(p).toContain("Closing skills (run before exit): /ke-learn, /simplify.");
  });

  it("falls back to AGENT_TABLE when no profile skills are passed", () => {
    const p = renderSystemPrompt({ ...base });
    expect(p).toContain("Opening skills");
    expect(p).not.toContain("Closing skills");
  });
});
