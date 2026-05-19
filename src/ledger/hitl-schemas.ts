// HITL prompt payload schemas. See ADR 0002 — UX Module Contract.
// Imported by the bookie validator and by UX modules to know what to render.

import { z } from "zod";

// Artifact ref. Three shapes:
//   inline: small payloads embedded directly (<=4KB by convention)
//   {sha256, ext}: content-addressable blob at ~/vault/artifacts/<sha256>.<ext>
//     (ADR 0006 §2; see src/ledger/artifact-store.ts)
//   path: legacy/explicit absolute path (back-compat)
export const artifactRef = z.object({
  type: z.enum([
    "text/markdown",
    "text/diff",
    "chart/vega-lite",
    "diagram/mermaid",
    "image/png",
    "table/rows",
  ]).optional(),
  inline: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  ext: z.string().regex(/^[a-z0-9]+$/).optional(),
  path: z.string().optional(),
}).refine(
  (a) => Boolean(a.inline) || Boolean(a.sha256) || Boolean(a.path),
  "artifact must have inline, sha256, or path",
).refine(
  (a) => !a.sha256 || Boolean(a.ext),
  "artifact with sha256 must also include ext",
);
export type ArtifactRef = z.infer<typeof artifactRef>;

export const askTextPayload = z.object({
  prompt: z.string().min(1),
  artifacts: z.array(artifactRef).default([]),
});

export const askChoicePayload = z.object({
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  artifacts: z.array(artifactRef).default([]),
});

export const askConfirmPayload = z.object({
  prompt: z.string().min(1),
  artifacts: z.array(artifactRef).default([]),
});

export const notifyPayload = z.object({
  message: z.string().min(1),
  level: z.enum(["info", "warn", "error"]).default("info"),
});

export const showArtifactPayload = z.object({
  caption: z.string().optional(),
  artifacts: z.array(artifactRef).min(1),
});

export const hitlKind = z.enum([
  "ask_text",
  "ask_choice",
  "ask_confirm",
  "notify",
  "show_artifact",
]);
export type HitlKind = z.infer<typeof hitlKind>;

export const payloadByKind = {
  ask_text: askTextPayload,
  ask_choice: askChoicePayload,
  ask_confirm: askConfirmPayload,
  notify: notifyPayload,
  show_artifact: showArtifactPayload,
} as const;

export function parsePayload(kind: HitlKind, raw: unknown) {
  return payloadByKind[kind].parse(raw);
}

// Artifacts referenced by a payload (empty for kinds without artifacts).
export function payloadArtifacts(kind: HitlKind, payload: unknown): ArtifactRef[] {
  if (kind === "notify") return [];
  const p = payload as { artifacts?: ArtifactRef[] };
  return p.artifacts ?? [];
}
