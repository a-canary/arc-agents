import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Module under test — import directly (top-level for Bun)
import {
  DEFAULT_BIN_SPEC,
  makeBinSpec,
  binSpecSchema,
  ANCHOR_STRATEGIES,
  RANKING_SCOPES,
  OVERLAP_MODES,
  CHUNKER_VERSIONS,
} from "./bin-spec.js";

import {
  buildBins,
  makePrng,
  hashString,
  chunkV1,
  estimateTokens,
} from "./bin-builder.js";

import type { CorpusDocument } from "./corpus-index.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** Build a minimal in-memory corpus index on disk and return the root path. */
function buildFixture(
  sources: Record<string, string[]>, // source → list of doc texts
): string {
  const root = mkdtempSync(join(tmpdir(), "bin-builder-fixture-"));
  mkdirSync(join(root, "_meta"));
  mkdirSync(join(root, "sources"), { recursive: true });

  const sourceNames = Object.keys(sources);
  const totalDocs = Object.values(sources).reduce((s, arr) => s + arr.length, 0);

  writeFileSync(
    join(root, "_meta", "index.json"),
    JSON.stringify({
      version: 1,
      sources: sourceNames,
      createdAt: "2026-05-29T00:00:00Z",
      totalDocs,
    }),
  );

  for (const [src, texts] of Object.entries(sources)) {
    const srcDir = join(root, "sources", src);
    mkdirSync(join(srcDir, "_meta"), { recursive: true });
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(
      join(srcDir, "_meta", "source.json"),
      JSON.stringify({ source: src, docCount: texts.length, fields: ["id", "text"] }),
    );

    const lines = texts.map((text, i) =>
      JSON.stringify({ id: `${src}:${i}`, text }),
    );
    writeFileSync(join(srcDir, "documents.jsonl"), lines.join("\n") + "\n");
  }

  return root;
}

// Convenience that mirrors the real corpus layout (source = top-level dir)
function buildFixtureV2(
  sources: Record<string, string[]>,
): string {
  const root = mkdtempSync(join(tmpdir(), "bin-builder-fixture-"));
  mkdirSync(join(root, "_meta"));

  const sourceNames = Object.keys(sources);
  const totalDocs = Object.values(sources).reduce((s, arr) => s + arr.length, 0);

  writeFileSync(
    join(root, "_meta", "index.json"),
    JSON.stringify({
      version: 1,
      sources: sourceNames,
      createdAt: "2026-05-29T00:00:00Z",
      totalDocs,
    }),
  );

  for (const [src, texts] of Object.entries(sources)) {
    mkdirSync(join(root, src, "_meta"), { recursive: true });
    mkdirSync(join(root, src), { recursive: true });

    writeFileSync(
      join(root, src, "_meta", "source.json"),
      JSON.stringify({ source: src, docCount: texts.length, fields: ["id", "text"] }),
    );

    const lines = texts.map((text, i) =>
      JSON.stringify({ id: `${src}:${i}`, text }),
    );
    writeFileSync(join(root, src, "documents.jsonl"), lines.join("\n") + "\n");
  }

  return root;
}

function readJsonl(dir: string, file: string) {
  const content = readFileSync(join(dir, file), "utf-8");
  return content
    .split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => JSON.parse(l));
}

// ─── BinSpec type tests ─────────────────────────────────────────────────────

test("DEFAULT_BIN_SPEC has Phase 1 values", () => {
  expect(DEFAULT_BIN_SPEC.anchor).toBe("stratified-by-source");
  expect(DEFAULT_BIN_SPEC.rankingScope).toBe("within-source");
  expect(DEFAULT_BIN_SPEC.topK).toBe(2200);
  expect(DEFAULT_BIN_SPEC.overlapMode).toBe("none");
  expect(DEFAULT_BIN_SPEC.overlapPercent).toBe(0.0);
  expect(DEFAULT_BIN_SPEC.chunkerVersion).toBe("v1");
  expect(DEFAULT_BIN_SPEC.trainRatio).toBe(0.9);
  expect(DEFAULT_BIN_SPEC.seed).toBe(42);
});

test("binSpecSchema accepts valid spec", () => {
  const result = binSpecSchema.safeParse(DEFAULT_BIN_SPEC);
  expect(result.success).toBe(true);
});

test("binSpecSchema rejects overlapPercent > 0.5", () => {
  const result = binSpecSchema.safeParse({
    ...DEFAULT_BIN_SPEC,
    overlapPercent: 0.6,
  });
  expect(result.success).toBe(false);
});

test("makeBinSpec applies defaults", () => {
  const spec = makeBinSpec({ topK: 1000 });
  expect(spec.topK).toBe(1000);
  expect(spec.anchor).toBe("stratified-by-source"); // from DEFAULT
  expect(spec.seed).toBe(42); // from DEFAULT
});

test("makeBinSpec rejects unknown anchor strategy", () => {
  expect(() =>
    makeBinSpec({ anchor: "unknown" as any }),
  ).toThrow();
});

// ─── Prng tests ───────────────────────────────────────────────────────────────

test("makePrng is deterministic", () => {
  const prng1 = makePrng(12345);
  const prng2 = makePrng(12345);
  const seq1 = Array.from({ length: 10 }, () => prng1());
  const seq2 = Array.from({ length: 10 }, () => prng2());
  expect(seq1).toEqual(seq2);
});

test("makePrng(0) does not crash and produces sequence", () => {
  const prng = makePrng(0);
  const seq = Array.from({ length: 5 }, () => prng());
  expect(seq.length).toBe(5);
  expect(seq.every((v) => v >= 0 && v < 1)).toBe(true);
});

// ─── Hash tests ───────────────────────────────────────────────────────────────

test("hashString is deterministic and stable", () => {
  expect(hashString("hello")).toBe(hashString("hello"));
  expect(typeof hashString("hello")).toBe("number");
  expect(hashString("hello")).not.toBe(0);
});

test("hashString differs for different inputs", () => {
  expect(hashString("a")).not.toBe(hashString("b"));
});

// ─── Chunker tests ────────────────────────────────────────────────────────────

test("estimateTokens is roughly 1/4 of text length", () => {
  expect(estimateTokens("a".repeat(400))).toBe(100);
  expect(estimateTokens("")).toBe(0);
});

test("chunkV1 produces at least one chunk for non-empty doc", () => {
  const doc = {
    id: "src:0" as const,
    text: "hello world this is a test document with some content",
    split: "train" as const,
  };
  const chunks = chunkV1(doc, 0, 10);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.chunkIdx).toBe(0);
  expect(chunks[0]!.id).toBe("src:0");
});

test("chunkV1 chunkCount increases with long text", () => {
  const short = chunkV1({ id: "s:0", text: "hi", split: "train" }, 0, 128);
  const long = chunkV1(
    { id: "s:0", text: "word ".repeat(200), split: "train" },
    0,
    128,
  );
  expect(long.length).toBeGreaterThanOrEqual(short.length);
});

test("chunkV1 respects chunkIdxOffset", () => {
  const chunks = chunkV1(
    { id: "s:0", text: "word ".repeat(300), split: "train" },
    100,
    128,
  );
  expect(chunks[0]!.chunkIdx).toBe(100);
  expect(chunks[chunks.length - 1]!.chunkIdx).toBe(100 + chunks.length - 1);
});

// ─── Integration tests ────────────────────────────────────────────────────────

test("buildBins: Phase 1 default — 90/10 split, no overlap, stratified", () => {
  // 3 sources × 100 docs each = 300 total
  const corpusRoot = buildFixtureV2({
    sourceA: Array.from({ length: 100 }, (_, i) => `doc A ${i}`),
    sourceB: Array.from({ length: 100 }, (_, i) => `doc B ${i}`),
    sourceC: Array.from({ length: 100 }, (_, i) => `doc C ${i}`),
  });
  const outputDir = mkdtempSync(join(tmpdir(), "bin-output-"));

  try {
    buildBins({}, { corpusRoot, outputDir });

    const train = readJsonl(outputDir, "train.jsonl");
    const test = readJsonl(outputDir, "test.jsonl");

    // Count unique document IDs (not chunks — short test docs fragment into many chunks)
    const trainDocIds = new Set(train.map((l) => l.id));
    const testDocIds = new Set(test.map((l) => l.id));
    const totalDocs = trainDocIds.size + testDocIds.size;

    // Phase 1: stratified-by-source with topK=2200 and 3 sources
    // → floor(2200/3) = 733 per source, but we only have 100 docs each
    // → all 100 docs per source selected = 300 total
    expect(totalDocs).toBe(300);

    // 90/10 split by document count
    const trainDocRatio = trainDocIds.size / totalDocs;
    expect(trainDocRatio).toBeCloseTo(0.9, 1);

    // No overlap: train ids ∩ test ids = ∅
    const overlap = [...testDocIds].filter((id) => trainDocIds.has(id));
    expect(overlap).toHaveLength(0);

    // Each source represented in both train and test
    const trainSources = new Set([...trainDocIds].map((id) => id.split(":")[0]));
    const testSources = new Set([...testDocIds].map((id) => id.split(":")[0]));
    expect(trainSources).toEqual(new Set(["sourceA", "sourceB", "sourceC"]));
    expect(testSources).toEqual(new Set(["sourceA", "sourceB", "sourceC"]));

    // Output files have chunks (short docs produce many chunks)
    expect(train.length).toBeGreaterThan(0);
    expect(test.length).toBeGreaterThan(0);
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("buildBins: alternate arm — overlap=10% via t-shaped mode", () => {
  const corpusRoot = buildFixtureV2({
    alpha: Array.from({ length: 200 }, (_, i) => `alpha doc ${i}`),
    beta: Array.from({ length: 200 }, (_, i) => `beta doc ${i}`),
  });
  const outputDir = mkdtempSync(join(tmpdir(), "bin-output-"));

  try {
    buildBins(
      { overlapMode: "t-shaped", overlapPercent: 0.1, seed: 7 },
      { corpusRoot, outputDir },
    );

    const train = readJsonl(outputDir, "train.jsonl");
    const test = readJsonl(outputDir, "test.jsonl");

    // t-shaped: train ∩ test is NOT empty — overlap exists
    const trainIds = new Set(train.map((l) => l.id));
    const testIds = test.map((l) => l.id);
    const overlap = testIds.filter((id) => trainIds.has(id));

    // With t-shaped at 10%, some overlap is expected
    // The exact count depends on source-level split, but at least some should exist
    // Since 2 sources × 200 docs, each source gets ~100 train / 100 test at 90/10
    // With 10% t-shaped: ~10 docs from each source appear in both sets
    expect(overlap.length).toBeGreaterThan(0);

    // test has more entries than a clean 10% split would give (t-shaped adds overlap to test)
    const cleanTestSize = Math.floor(400 * 0.1);
    expect(test.length).toBeGreaterThan(cleanTestSize);
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("buildBins: seed=0 produces deterministic output (no shuffle)", () => {
  const corpusRoot = buildFixtureV2({
    x: Array.from({ length: 50 }, (_, i) => `x ${i}`),
    y: Array.from({ length: 50 }, (_, i) => `y ${i}`),
  });
  const out1 = mkdtempSync(join(tmpdir(), "bin-output-1-"));
  const out2 = mkdtempSync(join(tmpdir(), "bin-output-2-"));

  try {
    buildBins({ seed: 0 }, { corpusRoot, outputDir: out1 });
    buildBins({ seed: 0 }, { corpusRoot, outputDir: out2 });

    const t1 = readJsonl(out1, "train.jsonl");
    const t2 = readJsonl(out2, "train.jsonl");
    expect(t1).toEqual(t2);

    const e1 = readJsonl(out1, "test.jsonl");
    const e2 = readJsonl(out2, "test.jsonl");
    expect(e1).toEqual(e2);
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(out1, { recursive: true, force: true });
    rmSync(out2, { recursive: true, force: true });
  }
});

test("buildBins: hand-picked anchors — only specified docs selected", () => {
  const corpusRoot = buildFixtureV2({
    cats: Array.from({ length: 10 }, (_, i) => `cat ${i}`),
    dogs: Array.from({ length: 10 }, (_, i) => `dog ${i}`),
  });
  const outputDir = mkdtempSync(join(tmpdir(), "bin-output-"));

  try {
    buildBins(
      {
        anchor: "hand-picked",
        handPickedAnchors: {
          cats: ["cats:0", "cats:2", "cats:5"],
          dogs: ["dogs:1"],
        },
        seed: 99,
      },
      { corpusRoot, outputDir },
    );

    const train = readJsonl(outputDir, "train.jsonl");
    const test = readJsonl(outputDir, "test.jsonl");
    const allIds = [...new Set([...train, ...test].map((l) => l.id))];

    expect(allIds).toContain("cats:0");
    expect(allIds).toContain("cats:2");
    expect(allIds).toContain("cats:5");
    expect(allIds).toContain("dogs:1");

    // Other docs should NOT be present
    expect(allIds).not.toContain("cats:1");
    expect(allIds).not.toContain("dogs:0");
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("buildBins: full-pool ranking scope — selects topK from entire pool", () => {
  const corpusRoot = buildFixtureV2({
    a: Array.from({ length: 50 }, (_, i) => `a doc ${i}`),
    b: Array.from({ length: 50 }, (_, i) => `b doc ${i}`),
  });
  const outputDir = mkdtempSync(join(tmpdir(), "bin-output-"));

  try {
    buildBins(
      { rankingScope: "full-pool", topK: 20, seed: 1 },
      { corpusRoot, outputDir },
    );

    const train = readJsonl(outputDir, "train.jsonl");
    const test = readJsonl(outputDir, "test.jsonl");

    // Count unique doc IDs (chunks multiply the count)
    const allIds = new Set([...train, ...test].map((l) => l.id));

    // 20 docs selected from the pool of 100 (50+50), regardless of source
    expect(allIds.size).toBe(20);
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("buildBins: throws for k-means-centroid (not implemented without embeddings)", () => {
  const corpusRoot = buildFixtureV2({
    a: ["doc 1", "doc 2"],
  });
  const outputDir = mkdtempSync(join(tmpdir(), "bin-output-"));

  try {
    expect(() =>
      buildBins(
        { anchor: "k-means-centroid" },
        { corpusRoot, outputDir },
      ),
    ).toThrow("k-means-centroid requires embeddings");
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});
