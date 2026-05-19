import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTemplate } from "./templates";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

// Mirrors the TABLE in templates.ts. Update when adding entries.
const ENTRIES: Array<[string, string]> = [
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
];

describe("opening_skills resolve to skills/<name>/SKILL.md", () => {
  for (const [kind, type] of ENTRIES) {
    const t = resolveTemplate(kind, type);
    for (const skill of t.opening_skills) {
      it(`${kind}/${type}: ${skill}`, () => {
        const path = join(SKILLS_DIR, skill, "SKILL.md");
        expect(existsSync(path)).toBe(true);
      });
    }
  }
});
