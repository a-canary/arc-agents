// slice-guard-focus.test.ts — tests for agentic per-hunk drive-by detector.
//
// Strategy: inject a deterministic mock analyzer so we never hit the real
// minimax endpoint in CI. Real-API behavior is covered by the SKIP path
// (MINIMAX_API_KEY absent) — exercised via the CLI smoke test below.

import { describe, expect, test } from "bun:test";
import {
  type Analyzer,
  type Hunk,
  type HunkVerdict,
  makeMinimaxAnalyzer,
  parseDiff,
  scoreDiff,
} from "./slice-guard-focus";

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@ export function foo() {
-  return 1;
+  return 2;
+  // bumped
@@ -40,2 +42,3 @@ function helper() {
-  log("old");
+  log("new");
+  metric("helper");
diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,1 +1,2 @@
-export const x = 1;
+export const x = 2;
+export const y = 99; // unrelated
`;

describe("parseDiff", () => {
  test("extracts one hunk per @@ header, attributed to the right file", () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    expect(hunks.length).toBe(3);
    expect(hunks[0]!.file).toBe("src/foo.ts");
    expect(hunks[1]!.file).toBe("src/foo.ts");
    expect(hunks[2]!.file).toBe("src/bar.ts");
    expect(hunks[0]!.header.startsWith("@@")).toBe(true);
    expect(hunks[0]!.body).toContain("+  return 2;");
    expect(hunks[2]!.body).toContain("+export const y = 99;");
  });

  test("empty input → no hunks", () => {
    expect(parseDiff("")).toEqual([]);
  });

  test("diff with no hunks (binary file etc.) → no hunks", () => {
    const raw =
      "diff --git a/foo.png b/foo.png\nBinary files a/foo.png and b/foo.png differ\n";
    expect(parseDiff(raw)).toEqual([]);
  });
});

function mockAnalyzer(map: Record<string, HunkVerdict["verdict"]>): Analyzer {
  return async (h) => {
    const verdict = map[h.file] ?? "on-task";
    return {
      file: h.file,
      header: h.header,
      verdict,
      reason: `mock:${verdict}`,
    };
  };
}

describe("scoreDiff", () => {
  const ctx = { title: "fix foo", body: "tighten foo()" };

  test("all on-task → 0% drive-by, PASS-side", async () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const score = await scoreDiff(hunks, ctx, mockAnalyzer({}));
    expect(score.total).toBe(3);
    expect(score.driveByCount).toBe(0);
    expect(score.driveByPct).toBe(0);
  });

  test("one of three drive-by → 33.3%, would exceed 25% cap", async () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const score = await scoreDiff(
      hunks,
      ctx,
      mockAnalyzer({ "src/bar.ts": "drive-by" }),
    );
    expect(score.driveByCount).toBe(1);
    expect(score.driveByPct).toBeCloseTo((1 / 3) * 100, 1);
    const labeled = score.verdicts.filter((v) => v.verdict === "drive-by");
    expect(labeled.length).toBe(1);
    expect(labeled[0]!.file).toBe("src/bar.ts");
  });

  test("all drive-by → 100%, hard FAIL territory", async () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const score = await scoreDiff(
      hunks,
      ctx,
      mockAnalyzer({
        "src/foo.ts": "drive-by",
        "src/bar.ts": "drive-by",
      }),
    );
    expect(score.driveByCount).toBe(3);
    expect(score.driveByPct).toBe(100);
  });

  test("all unknown → pct=0 (caller treats as SKIP)", async () => {
    const hunks = parseDiff(SAMPLE_DIFF);
    const allUnknown: Analyzer = async (h) => ({
      file: h.file,
      header: h.header,
      verdict: "unknown",
      reason: "api down",
    });
    const score = await scoreDiff(hunks, ctx, allUnknown);
    expect(score.unknownCount).toBe(3);
    expect(score.driveByCount).toBe(0);
    expect(score.driveByPct).toBe(0);
  });

  test("mixed unknown + drive-by: unknown excluded from denominator", async () => {
    // 3 hunks: 1 on-task, 1 drive-by, 1 unknown → denom=2, pct=50%
    const hunks = parseDiff(SAMPLE_DIFF);
    let i = 0;
    const seq = ["on-task", "drive-by", "unknown"] as const;
    const mixed: Analyzer = async (h) => {
      const verdict = seq[i++] ?? "unknown";
      return { file: h.file, header: h.header, verdict, reason: "mixed" };
    };
    const score = await scoreDiff(hunks, ctx, mixed);
    expect(score.driveByCount).toBe(1);
    expect(score.unknownCount).toBe(1);
    expect(score.driveByPct).toBe(50);
  });
});

describe("makeMinimaxAnalyzer", () => {
  const sampleHunk: Hunk = {
    file: "src/foo.ts",
    header: "@@ -1,1 +1,2 @@",
    body: "+export const y = 99;",
  };

  test("parses Anthropic-shape JSON response", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: '{"verdict":"drive-by","reason":"unrelated constant"}',
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    const analyzer = makeMinimaxAnalyzer({ apiKey: "x", fetchImpl });
    const v = await analyzer(sampleHunk, { title: "fix foo", body: "" });
    expect(v.verdict).toBe("drive-by");
    expect(v.reason).toBe("unrelated constant");
  });

  test("extracts JSON from prose-wrapped response", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text:
                'Looking at this hunk:\n{"verdict":"on-task","reason":"matches stated fix"}\nDone.',
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const analyzer = makeMinimaxAnalyzer({ apiKey: "x", fetchImpl });
    const v = await analyzer(sampleHunk, { title: "fix foo", body: "" });
    expect(v.verdict).toBe("on-task");
  });

  test("non-2xx → unknown verdict (excluded from denominator)", async () => {
    const fetchImpl = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const analyzer = makeMinimaxAnalyzer({ apiKey: "x", fetchImpl });
    const v = await analyzer(sampleHunk, { title: "fix foo", body: "" });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toContain("429");
  });

  test("network throw → unknown verdict", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const analyzer = makeMinimaxAnalyzer({ apiKey: "x", fetchImpl });
    const v = await analyzer(sampleHunk, { title: "fix foo", body: "" });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toContain("ECONNRESET");
  });

  test("unparseable model output → unknown verdict", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "I cannot decide." }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const analyzer = makeMinimaxAnalyzer({ apiKey: "x", fetchImpl });
    const v = await analyzer(sampleHunk, { title: "fix foo", body: "" });
    expect(v.verdict).toBe("unknown");
  });
});
