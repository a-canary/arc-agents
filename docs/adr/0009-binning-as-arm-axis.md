# ADR 0009 — Binning as Arm Axis for starlight-hats

**Status:** accepted  
**Date:** 2026-05-29  
**Authors:** arc-worker-a-ojdq43

## Context

starlight-hats (sub-project of starlight-slm) experiments with multiple model "hats" (architectures/strategies) trained on different data slices. Phase 1 used a fixed binning strategy (stratified-by-source, within-source top-2200, 90/10 split, v1 chunker). Subsequent arms need to vary binning parameters — but the binning code was ad-hoc Python with hard-coded values.

## Decision

Implement a typed `BinSpec` interface + deterministic `buildBins()` builder. Bin shape is an **artifact-controlled axis that arms vary**, not a fixed schema. Each arm is defined by its `BinSpec`; no code changes required to define a new arm.

## Design

### BinSpec axes

| Field | Type | Phase 1 default | Description |
|---|---|---|---|
| `anchor` | `AnchorStrategy` | `"stratified-by-source"` | How to select representative samples per source |
| `rankingScope` | `RankingScope` | `"within-source"` | Rank within source or across full pool |
| `topK` | `number` | `2200` | Maximum candidates per source |
| `overlapMode` | `OverlapMode` | `"none"` | Overlap between train and test |
| `overlapPercent` | `number` | `0.0` | Fraction of train in test (0–0.5) |
| `overlapSigma` | `number` | `1.0` | Gaussian sigma for soft overlap |
| `chunkerVersion` | `ChunkerVersion` | `"v1"` | Text chunking pipeline |
| `trainRatio` | `number` | `0.9` | Train fraction; test = 1 - trainRatio |
| `seed` | `number` | `42` | Reproducibility seed; 0 = fully deterministic |
| `handPickedAnchors` | `Record<string,string[]>` | — | Explicit anchor IDs (anchor=hand-picked) |
| `kMeansK` | `number` | — | k for k-means-centroid anchor strategy |

### Anchor strategies

- **`stratified-by-source`** (Phase 1): equal docs per source, sorted by id. No embeddings required.
- **`k-means-centroid`**: cluster embeddings, pick nearest-to-centroid docs. Requires `embeddings.f32`.
- **`hand-picked`**: explicit corpus document IDs per source. For known-hard slices.

### Ranking scopes

- **`within-source`** (Phase 1): rank independently within each source.
- **`full-pool`**: rank all candidates across all sources, take top-K total.

### Overlap modes

- **`none`** (Phase 1, 0%): train ∩ test = ∅. Clean split.
- **`t-shaped`**: top `overlapPercent`% of each source's train also in test. Models see a "stem" + "hat" overlap at eval.
- **`gaussian-weighted`**: test sampled with Gaussian weight near train docs. Requires embeddings.

### Reproducibility

`buildBins(spec, options)` is deterministic: same spec + same corpus index → identical `train.jsonl` + `test.jsonl`. The seed drives:
1. Per-source shuffle (Fisher-Yates, source-seeded)
2. Any stochastic steps (Gaussian overlap — stubbed without embeddings)

### Output format

```
<outputDir>/
├── train.jsonl  # { id, text, tokens, chunkIdx, split: "train" }
└── test.jsonl   # { id, text, tokens, chunkIdx, split: "test" }
```

### v1 chunker

Fixed 128-token windows, greedy whitespace boundary detection. `estimateTokens()` = `ceil(chars / 4)`.

## Consequences

### Positive
- Arms are defined by data, not code — new experiments require only BinSpec edits
- Determinism enables exact reproduction of Phase 1 slices
- Type safety + Zod schema validation catches misconfigured arms early

### Negative / deferred
- k-means-centroid and gaussian-weighted overlap require `embeddings.f32` per source — stubbed until corpus pre-computation pipeline exists
- Chunker v2 (sliding window, sentence-aware) is unimplemented
- No validation that the corpus index exists before building

## Implementation

- `src/starlight-hats/bin-spec.ts` — types, enums, `DEFAULT_BIN_SPEC`, `makeBinSpec()`, Zod schema
- `src/starlight-hats/corpus-index.ts` — corpus index layout, reader helpers
- `src/starlight-hats/bin-builder.ts` — `buildBins()`, `chunkV1()`, `selectAnchors()`, `rankCandidates()`, `applyOverlap()`, `splitPerSource()`
- `src/starlight-hats/bin-builder.test.ts` — 19 tests covering all axes + integration

## Alternatives considered

1. **Keep ad-hoc Python**: rejected — hard to vary arms, no type safety, no reproducibility
2. **External config JSON**: rejected — no validation, no TypeScript type inference
3. **Separate builder per arm**: rejected — code duplication, no single interface to evolve
