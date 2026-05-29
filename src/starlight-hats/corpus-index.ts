// Corpus index types and helpers for starlight-hats binning.
//
// Corpus index layout (mirrors starlight-slm shared_data/ structure):
//
//   <corpusRoot>/
//   ├── _meta/
//   │   └── index.json          # top-level manifest
//   ├── codeparrot/
//   │   ├── _meta/
//   │   │   └── source.json      # per-source manifest (cardinality, field names)
//   │   └── documents.jsonl     # one doc per line: { id, text, ... }
//   ├── openai_humaneval/
//   │   └── ...
//   └── ...
//
// index.json shape:
//   { version: 1, sources: string[], createdAt: string, totalDocs: number }
//
// document.jsonl shape (per source):
//   { id: string, text: string, tokenCount?: number, meta?: Record<string, unknown> }
//
// Embedding files (optional, only needed for k-means-centroid / gaussian-weighted):
//   <corpusRoot>/<source>/embeddings.f32  # float32 raw, 1 row per doc, dim=D
//   Shape: (numDocs, embeddingDim) — row i corresponds to document.jsonl line i.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CORPUS_INDEX_VERSION = 1;

// ─── Manifest types ──────────────────────────────────────────────────────────

export interface CorpusMeta {
  version: 1;
  sources: string[];
  createdAt: string;
  totalDocs: number;
}

export interface SourceMeta {
  source: string;
  docCount: number;
  fields: string[]; // JSON fields present in each document.jsonl line
  embeddingDim?: number; // present only when embeddings.f32 exists
}

// ─── Document ─────────────────────────────────────────────────────────────────

export interface CorpusDocument {
  id: string;
  text: string;
  tokenCount?: number;
  meta?: Record<string, unknown>;
}

// ─── Corpus index reader ──────────────────────────────────────────────────────

export interface CorpusIndex {
  meta: CorpusMeta;
  sources: Record<string, SourceMeta>;
}

/** Load the top-level corpus index manifest. */
export function loadCorpusMeta(corpusRoot: string): CorpusMeta {
  const raw = readFileSync(join(corpusRoot, "_meta", "index.json"), "utf-8");
  return JSON.parse(raw) as CorpusMeta;
}

/** Load a single source's manifest. */
export function loadSourceMeta(corpusRoot: string, source: string): SourceMeta {
  const raw = readFileSync(
    join(corpusRoot, source, "_meta", "source.json"),
    "utf-8",
  );
  return JSON.parse(raw) as SourceMeta;
}

/** Load all documents for a source from its JSONL file. */
export function loadSourceDocuments(corpusRoot: string, source: string): CorpusDocument[] {
  const lines = readFileSync(
    join(corpusRoot, source, "documents.jsonl"),
    "utf-8",
  ).split("\n").filter((l) => l.trim() !== "");
  return lines.map((line, idx) => {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const id: string = (typeof raw.id === "string" ? raw.id : `${source}:${idx}`);
    return { id, text: String(raw.text ?? ""), tokenCount: raw.tokenCount as number | undefined, meta: raw.meta as Record<string, unknown> | undefined };
  });
}

/**
 * Load the full corpus index (all manifests, no document bodies).
 * For production use: prefer lazy loading via `loadSourceDocuments` per source.
 */
export function loadCorpusIndex(corpusRoot: string): CorpusIndex {
  const meta = loadCorpusMeta(corpusRoot);
  const sources: Record<string, SourceMeta> = {};
  for (const src of meta.sources) {
    sources[src] = loadSourceMeta(corpusRoot, src);
  }
  return { meta, sources };
}

/** Total document count across all sources. */
export function totalDocCount(index: CorpusIndex): number {
  return Object.values(index.sources).reduce((sum, s) => sum + s.docCount, 0);
}

/** Total candidate pool after applying topK per source. */
export function candidatePoolSize(
  index: CorpusIndex,
  topK: number,
): number {
  return Math.min(
    topK,
    Object.values(index.sources).reduce((sum, s) => sum + s.docCount, 0),
  );
}
