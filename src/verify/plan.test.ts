// Tests for src/verify/plan.ts
import { describe, expect, test } from "bun:test";
import { checkSections, checkReferences, surfaceAssumptions } from "./plan";

// ─── Section completeness ────────────────────────────────────────────────────────

describe("checkSections", () => {
  test("pass: all required sections found", () => {
    const md = `# Goals\n\nBuild X.\n\n## Requirements\n\n- [ ] Foo\n\n## Success Criteria\n\n- Bar works.\n`;
    const results = checkSections(md);
    expect(results.filter((r) => r.found).map((r) => r.name)).toEqual([
      "Goals",
      "Requirements",
      "Success Criteria",
    ]);
    expect(results.find((r) => r.name === "Goals")!.status).toBe("pass");
  });

  test("fail: missing required sections", () => {
    const md = `# Overview\n\nJust an intro.\n`;
    const results = checkSections(md);
    expect(results.filter((r) => r.name === "Goals").find((r) => !r.found)).toBeTruthy();
    expect(results.filter((r) => r.name === "Requirements").find((r) => !r.found)).toBeTruthy();
    expect(results.filter((r) => r.name === "Success Criteria").find((r) => !r.found)).toBeTruthy();
  });

  test("warn: recommended sections absent", () => {
    const md = `# Goals\n\n## Requirements\n\n## Success Criteria\n\n`;
    const results = checkSections(md);
    const milestones = results.find((r) => r.name === "Milestones")!;
    const risks = results.find((r) => r.name === "Risks/Assumptions")!;
    // Warn is the default status for recommended sections absent; found overrides to pass.
    expect(milestones.status).toBe("warn");
    expect(risks.status).toBe("warn");
  });

  test("goals alternate headers: objective", () => {
    const md = `# Objective\n\nWin.\n`;
    const results = checkSections(md);
    expect(results.find((r) => r.name === "Goals")!.found).toBe(true);
  });

  test("success criteria alternate headers: definition of done", () => {
    const md = `## Definition of Done\n\nShip it.\n`;
    const results = checkSections(md);
    expect(results.find((r) => r.name === "Success Criteria")!.found).toBe(true);
  });

  test("milestones alternate headers: phases", () => {
    const md = `## Phases\n\nPhase 1.\n`;
    const results = checkSections(md);
    expect(results.find((r) => r.name === "Milestones")!.found).toBe(true);
  });

  test("h2 vs h1: both match", () => {
    const h2 = checkSections("## Goals\n\nGo.\n");
    const h1 = checkSections("# Goals\n\nGo.\n");
    expect(h2.find((r) => r.name === "Goals")!.found).toBe(true);
    expect(h1.find((r) => r.name === "Goals")!.found).toBe(true);
  });

  test("case-insensitive", () => {
    const md = "# goals\n\n## REQUIREMENTS\n\n## Success Criteria\n\n";
    const results = checkSections(md);
    expect(results.find((r) => r.name === "Goals")!.found).toBe(true);
  });

  test("sub-phrase match: 'assumptions and risks'", () => {
    const md = "## Assumptions and Risks\n\nfoo\n";
    const results = checkSections(md);
    expect(results.find((r) => r.name === "Risks/Assumptions")!.found).toBe(true);
  });
});

// ─── Reference integrity ─────────────────────────────────────────────────────

describe("checkReferences", () => {
  const BASE = "/tmp/plan/test";

  test("http link tracked as url type", () => {
    const md = `[Search](https://example.com)\n`;
    const results = checkReferences(md, BASE);
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("url");
    expect(results[0]!.target).toBe("https://example.com");
  });

  test("local file link: resolve from baseDir", () => {
    // Use an existing real file for integration coverage.
    const md = `[Readme](./README.md)\n`;
    const results = checkReferences(md, "/home/aaron/worktrees/arc-agents-implement-verify-plan-validation-harness");
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("file");
    expect(results[0]!.status).toBe("ok");
  });

  test("broken local file link", () => {
    const md = `[Missing](nonexistent-file.md)\n`;
    const results = checkReferences(md, "/tmp");
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("broken-file");
    expect(results[0]!.status).toBe("broken");
  });

  test("internal xref [slug]() skipped", () => {
    const md = `[See below](#section)\n`;
    const results = checkReferences(md, BASE);
    expect(results).toHaveLength(0);
  });

  test("no-link lines: no results", () => {
    const md = `Just text.\n\nNo links here.\n`;
    const results = checkReferences(md, BASE);
    expect(results).toHaveLength(0);
  });

  test("line numbers correct", () => {
    const md = `Line 1\nLine 2\n[Foo](bar.md)\nLine 4\n`;
    const results = checkReferences(md, BASE);
    expect(results).toHaveLength(1);
    expect(results[0]!.line).toBe(3);
  });

  test("multiple links on same line: all captured", () => {
    const md = `See [A](a.md) and [B](b.md).`;
    const results = checkReferences(md, BASE);
    expect(results).toHaveLength(2);
  });
});

// ─── Assumption surfacing ─────────────────────────────────────────────────────

describe("surfaceAssumptions", () => {
  test("high: explicit '- assumption:' marker", () => {
    const md = `- assumption: users have existing accounts\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe("high");
  });

  test("high: '* assumption:' marker", () => {
    const md = `* assumption: the model supports streaming\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe("high");
  });

  test("high: '> assumption:' blockquote", () => {
    const md = `> assumption: backend remains stable\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe("high");
  });

  test("high: '# assumption:' heading", () => {
    const md = `# assumption: we ship by Q3\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe("high");
  });

  test("medium: checklist item with assumption keyword", () => {
    const md = `- [ ] assume: the user is authenticated\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe("medium");
  });

  test("medium: numbered list with assumption keyword", () => {
    const md = `1. we assume the DB is reachable\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe("medium");
  });

  test("case-insensitive", () => {
    const md = `- Assumption: thing works\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBe("high");
  });

  test("no-match: plain text", () => {
    const md = `This is a plain plan document.\n\nNothing to assume.\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(0);
  });

  test("line numbers correct", () => {
    const md = `Line 1\nLine 2\n- assumption: test\nLine 4\n`;
    const results = surfaceAssumptions(md);
    expect(results).toHaveLength(1);
    expect(results[0]!.line).toBe(3);
  });
});
