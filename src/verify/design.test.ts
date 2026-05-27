// Tests for src/verify/design.ts
import { describe, expect, test } from "bun:test";
import { checkDesignSections } from "./design";

describe("checkDesignSections", () => {
  test("pass: all required sections found", () => {
    const lines = [
      "# Overview", "",
      "Purpose of this design.", "",
      "## Architecture", "",
      "A -> B", "",
      "## API", "",
      "GET /x",
    ];
    const md = lines.join("\n");
    const results = checkDesignSections(md);
    expect(results.filter((r) => r.found).map((r) => r.name)).toEqual([
      "Overview",
      "Architecture",
      "API/Interface",
    ]);
  });

  test("fail: missing required sections", () => {
    const md = "# Random Doc\n\nNo design structure.\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "Overview")!.found).toBe(false);
    expect(results.find((r) => r.name === "Architecture")!.found).toBe(false);
    expect(results.find((r) => r.name === "API/Interface")!.found).toBe(false);
  });

  test("warn: recommended sections absent", () => {
    const md = "# Overview\n## Architecture\n## API\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "Edge Cases")!.status).toBe("warn");
    expect(results.find((r) => r.name === "Open Questions")!.status).toBe("warn");
  });

  test("alternate headers: introduction = Overview", () => {
    const md = "## Introduction\n\nContext.\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "Overview")!.found).toBe(true);
  });

  test("alternate headers: data model = Architecture", () => {
    const md = "## Data Model\n\nTables.\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "Architecture")!.found).toBe(true);
  });

  test("alternate headers: endpoints = API/Interface", () => {
    const md = "## Endpoints\n\n/api/v1\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "API/Interface")!.found).toBe(true);
  });

  test("case-insensitive", () => {
    const md = "# OVERVIEW\n## ARCHITECTURE\n## api\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "Overview")!.found).toBe(true);
    expect(results.find((r) => r.name === "Architecture")!.found).toBe(true);
    expect(results.find((r) => r.name === "API/Interface")!.found).toBe(true);
  });

  test("sub-phrase: architecture overview", () => {
    const md = "## Architecture Overview\n\nHigh-level.\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "Architecture")!.found).toBe(true);
  });

  test("trade-offs header matches Open Questions", () => {
    const md = "## Trade-offs and Decisions\n\nWeighing options.\n";
    const results = checkDesignSections(md);
    expect(results.find((r) => r.name === "Open Questions")!.found).toBe(true);
  });
});
