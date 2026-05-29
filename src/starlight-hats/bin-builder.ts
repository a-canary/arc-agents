// Deterministic bin-builder for starlight-hats.
//
// Takes a BinSpec and a corpus index root, emits train.jsonl and test.jsonl
// to the specified output directory. All stochastic steps are seeded by
// spec.seed so the output is reproducible.
//
// Phase 1 (DEFAULT_BIN_SPEC) → train.jsonl + test.jsonl:
//   - Stratified-by-source: floor(2200 / numSources) per source
//   - Within-source ranking: by doc id (deterministic, no score needed)
//   - No overlap: train ∩ test = ∅
//   - 90% train / 10% test split within each source's selection
//   - v1 chunker: 128-token fixed chunks
//
// Output format (train.jsonl / test.jsonl):
//   { id: string, text: string, tokens: number, chunkIdx: number, split: "train"|"test" }
//
// Chunked format (per output line):
//   { id: string, text: string, tokens: number, chunkIdx: number, split: "train"|"test" }
//
// Raw format (before chunking):
//   { id: string, source: string, text: string, tokens: number, split: "train"|"test" }

import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSourceDocuments, loadCorpusMeta, type CorpusDocument } from "./corpus-index.js";
import {
  type BinSpec,
  DEFAULT_BIN_SPEC,
} from "./bin-spec.js";

// ─── Seeded PRNG (xoshiro128** — fast, deterministic, good distribution) ───────

/** Simple seeded 64-bit PRNG using a linear congruential generator. */
export function makePrng(seed: number): () => number {
  // Seed the LCG with a scramble function so small seeds mix well
  let s = Math.floor(seed) >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

export interface ChunkedDocument {
  id: string;
  text: string;
  tokens: number;
  chunkIdx: number;
  split: "train" | "test";
}

/** Document with a split label — input to chunkV1 from the pipeline. */
interface ChunkableDocument {
  id: string;
  text: string;
  split: "train" | "test";
}

/**
 * v1 chunker: fixed `chunkSize` token windows, no overlap.
 * Greedy boundary: break at nearest whitespace before or at chunkSize.
 */
export function chunkV1(
  doc: ChunkableDocument,
  chunkIdxOffset: number,
  chunkSize = 128,
): ChunkedDocument[] {
  const text = doc.text;
  const result: ChunkedDocument[] = [];
  let pos = 0;
  let idx = chunkIdxOffset;

  while (pos < text.length) {
    const endRaw = Math.min(pos + chunkSize * 4, text.length); // ~4 chars per token
    let end = Math.min(pos + chunkSize * 4, text.length);
    // Back up to whitespace boundary
    while (end > pos + 1 && !/\s/.test(text[end - 1]!)) end--;
    if (end === pos) end = Math.min(pos + chunkSize * 4, text.length); // no whitespace found

    const chunkText = text.slice(pos, end).trim();
    if (chunkText.length > 0) {
      result.push({
        id: doc.id,
        text: chunkText,
        tokens: estimateTokens(chunkText),
        chunkIdx: idx++,
        split: doc.split,
      });
    }
    pos = end;
  }

  // If the document was shorter than chunkSize, emit the whole thing as one chunk
  if (result.length === 0 && text.trim().length > 0) {
    result.push({
      id: doc.id,
      text: text.trim(),
      tokens: estimateTokens(text.trim()),
      chunkIdx: chunkIdxOffset,
      split: doc.split,
    });
  }

  return result;
}

/** Rough token estimate: ~4 chars per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Anchor selection ─────────────────────────────────────────────────────────

/**
 * Select anchors per source according to spec.anchor strategy.
 *
 * `stratified-by-source`: floor(topK / numSources) docs per source, sorted by id.
 * `k-means-centroid`: not implemented (requires embeddings.f32).
 * `hand-picked`: look up handPickedAnchors[source].
 *
 * Returns a Map<source, CorpusDocument[]>.
 */
export function selectAnchors(
  spec: BinSpec,
  corpusRoot: string,
  sourceDocs: Map<string, CorpusDocument[]>,
): Map<string, CorpusDocument[]> {
  const sources = [...sourceDocs.keys()];
  const numSources = sources.length;

  switch (spec.anchor) {
    case "stratified-by-source": {
      const perSource = Math.max(1, Math.floor(spec.topK / numSources));
      const anchors = new Map<string, CorpusDocument[]>();
      for (const src of sources) {
        const docs = [...sourceDocs.get(src)!].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        anchors.set(src, docs.slice(0, perSource));
      }
      return anchors;
    }

    case "hand-picked": {
      const anchors = new Map<string, CorpusDocument[]>();
      for (const src of sources) {
        const idSet = new Set(spec.handPickedAnchors?.[src] ?? []);
        const docs = sourceDocs.get(src)!.filter((d) => idSet.has(d.id));
        anchors.set(src, docs);
      }
      return anchors;
    }

    case "k-means-centroid": {
      // Requires embeddings — implemented in bin-builder-embeddings.ts
      throw new Error(
        "k-means-centroid requires embeddings. " +
        "Import from 'bin-builder-embeddings.js' and provide embeddings.f32 files.",
      );
    }
  }
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Rank candidates within each source according to spec.rankingScope.
 *
 * `within-source`: return topK docs per source (deterministic by id).
 * `full-pool`: rank all docs across all sources together; take topK total.
 *
 * Returns a flat array of { doc, source }.
 */
export function rankCandidates(
  spec: BinSpec,
  anchors: Map<string, CorpusDocument[]>,
): Array<{ doc: CorpusDocument; source: string }> {
  switch (spec.rankingScope) {
    case "within-source": {
      const ranked: Array<{ doc: CorpusDocument; source: string }> = [];
      for (const [source, docs] of anchors) {
        const sorted = [...docs].sort((a, b) => a.id.localeCompare(b.id));
        ranked.push(...sorted.slice(0, spec.topK).map((doc) => ({ doc, source })));
      }
      return ranked;
    }

    case "full-pool": {
      // Flatten all anchors, sort globally by id, take topK
      const all: Array<{ doc: CorpusDocument; source: string }> = [];
      for (const [source, docs] of anchors) {
        all.push(...docs.map((doc) => ({ doc, source })));
      }
      return [...all].sort((a, b) => a.doc.id.localeCompare(b.doc.id)).slice(0, spec.topK);
    }
  }
}

// ─── Overlap ─────────────────────────────────────────────────────────────────

/**
 * Apply overlap strategy between train and test.
 *
 * `none`: no overlap (Phase 1 default).
 * `t-shaped`: top `overlapPercent`% of train also in test.
 * `gaussian-weighted`: test sampled with Gaussian weight near train (not implemented).
 */
export function applyOverlap(
  spec: BinSpec,
  candidates: Array<{ doc: CorpusDocument; source: string }>,
): Array<{ doc: CorpusDocument; source: string; split: "train" | "test" }> {
  const withSplit: Array<{ doc: CorpusDocument; source: string; split: "train" | "test" }> =
    candidates.map((c) => ({ ...c, split: "train" as const }));

  if (spec.overlapMode === "none") {
    // Deterministic 90/10 split per source
    return splitPerSource(withSplit, spec.trainRatio, spec.seed);
  }

  if (spec.overlapMode === "t-shaped") {
    // First split train/test within each source, then promote top overlapPercent
    // of train into test
    const split = splitPerSource(withSplit, spec.trainRatio, spec.seed);
    const overlapCount = Math.max(
      1,
      Math.floor(withSplit.length * spec.overlapPercent),
    );

    // Mark the first `overlapCount` train candidates as overlapping (both in train + test)
    let added = 0;
    for (const item of split) {
      if (item.split === "train" && added < overlapCount) {
        // Promote: add a duplicate entry as test
        const dup = { ...item, split: "test" as const };
        split.push(dup);
        added++;
      }
      if (added >= overlapCount) break;
    }
    return split;
  }

  if (spec.overlapMode === "gaussian-weighted") {
    // Gaussian overlap: requires embedding distances — stub for now
    throw new Error(
      "gaussian-weighted overlap requires embedding distances. " +
      "Implement using embeddings.f32.",
    );
  }

  // Should never reach here — all modes are handled above.
  return withSplit;
}

// ─── Split ───────────────────────────────────────────────────────────────────

function splitPerSource(
  items: Array<{ doc: CorpusDocument; source: string; split: "train" | "test" }>,
  trainRatio: number,
  seed: number,
): Array<{ doc: CorpusDocument; source: string; split: "train" | "test" }> {
  // Group by source
  const bySource = new Map<string, typeof items>();
  for (const item of items) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source)!.push(item);
  }

  const result: typeof items = [];
  for (const [source, srcItems] of bySource) {
    // Sort by doc id for determinism (already sorted from rankCandidates)
    const sorted = [...srcItems].sort((a, b) => a.doc.id.localeCompare(b.doc.id));

    // Seed the source-level shuffle with a hash of (seed, source)
    const sourceSeed = hashString(String(seed) + source);
    const sourcePrng = makePrng(sourceSeed);

    // Fisher-Yates shuffle with source-specific PRNG
    for (let i = sorted.length - 1; i > 0; i--) {
      const j = Math.floor(sourcePrng() * (i + 1));
      const si = sorted[i]!;
      const sj = sorted[j]!;
      sorted[i] = sj;
      sorted[j] = si;
    }

    const splitIdx = Math.floor(sorted.length * trainRatio);
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i]!;
      result.push({
        ...item,
        split: i < splitIdx ? "train" : "test",
      });
    }
  }

  return result;
}

// ─── Simple string hash (djb2) ────────────────────────────────────────────────

/** Deterministic 32-bit hash for seed mixing. */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export interface BuildOptions {
  corpusRoot: string;
  outputDir: string;
  spec?: Partial<BinSpec>;
}

/** Deterministic chunk output line. */
interface ChunkLine {
  id: string;
  text: string;
  tokens: number;
  chunkIdx: number;
  split: "train" | "test";
}

/**
 * Build train.jsonl and test.jsonl from corpus index + BinSpec.
 *
 * Pipeline:
 *   load corpus → select anchors → rank → apply overlap → chunk → write
 *
 * Fully deterministic: same spec + corpusRoot → identical outputs.
 */
export function buildBins(spec_: Partial<BinSpec> = {}, options: BuildOptions): void {
  const spec: BinSpec = { ...DEFAULT_BIN_SPEC, ...spec_ };
  const { corpusRoot, outputDir } = options;

  // 1. Load all source documents
  const meta = loadCorpusMeta(corpusRoot);

  const sourceDocs = new Map<string, CorpusDocument[]>();
  for (const src of meta.sources) {
    sourceDocs.set(src, loadSourceDocuments(corpusRoot, src));
  }

  // 2. Select anchors
  const anchors = selectAnchors(spec, corpusRoot, sourceDocs);

  // 3. Rank
  const candidates = rankCandidates(spec, anchors);

  // 4. Apply overlap → assign train/test split
  const withSplit = applyOverlap(spec, candidates);

  // 5. Chunk + write
  const trainLines: ChunkLine[] = [];
  const testLines: ChunkLine[] = [];

  for (const item of withSplit) {
    const chunks = chunkV1(
      { id: item.doc.id, text: item.doc.text, split: item.split },
      0,
    );
    for (const chunk of chunks) {
      if (chunk.split === "train") {
        trainLines.push(chunk);
      } else {
        testLines.push(chunk);
      }
    }
  }

  // Sort chunks by id for determinism
  const sortChunks = (a: ChunkLine, b: ChunkLine) => a.id.localeCompare(b.id);
  trainLines.sort(sortChunks);
  testLines.sort(sortChunks);

  // Re-index chunkIdx
  let idx = 0;
  for (const line of trainLines) line.chunkIdx = idx++;
  idx = 0;
  for (const line of testLines) line.chunkIdx = idx++;

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "train.jsonl"), trainLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(outputDir, "test.jsonl"), testLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
