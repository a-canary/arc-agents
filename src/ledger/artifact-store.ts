// Content-addressable artifact store. ADR 0006 §2.
// Layout: ~/vault/artifacts/<sha256>.<ext>. Write-once, idempotent.
// hitl_deliveries.payload.artifacts[] holds {sha256, ext} refs; a future GC
// reaps blobs no longer referenced.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function artifactRoot(): string {
  return process.env.ARC_ARTIFACT_ROOT ?? join(homedir(), "vault", "artifacts");
}

function normExt(ext: string): string {
  const e = ext.startsWith(".") ? ext.slice(1) : ext;
  if (!/^[a-z0-9]+$/i.test(e)) throw new Error(`invalid ext: ${ext}`);
  return e.toLowerCase();
}

export function artifactPath(sha256: string, ext: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`invalid sha256: ${sha256}`);
  return join(artifactRoot(), `${sha256}.${normExt(ext)}`);
}

export function storeArtifact(
  bytes: Uint8Array | Buffer | string,
  ext: string,
): { sha256: string; ext: string; path: string } {
  const buf = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const e = normExt(ext);
  const path = artifactPath(sha256, e);
  if (!existsSync(path)) {
    mkdirSync(artifactRoot(), { recursive: true });
    writeFileSync(path, buf);
  }
  return { sha256, ext: e, path };
}
