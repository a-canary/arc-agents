// ADR 0006 — arc-ux artifacts module.
// storeArtifact({kind, body, originating_row_id, ext?}) -> uuid
// bytes <= 16 KiB -> inline_body. bytes > 16 KiB -> ref_path under
// ~/vault/arc-ux/artifacts/<uuid>.<ext>. Insert artifacts row + file write
// happen together; row insert is the transactional commit.

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const INLINE_CUTOFF_BYTES = 16 * 1024;

export type StoreArgs = {
  kind: string;
  body: string | Uint8Array;
  originating_row_id: string;
  ext?: string;
};

export type Artifact = {
  uuid: string;
  kind: string;
  ref_path: string | null;
  inline_body: string | null;
  bytes: number;
};

function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function artifactsDir(): string {
  return process.env.ARC_ARTIFACTS_DIR ?? `${process.env.HOME}/vault/arc-ux/artifacts`;
}

function byteLength(body: string | Uint8Array): number {
  return typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
}

export function storeArtifact(db: Database, args: StoreArgs): string {
  const { kind, body, originating_row_id, ext } = args;
  if (!kind) throw new Error("storeArtifact: kind required");
  if (!originating_row_id) throw new Error("storeArtifact: originating_row_id required");

  const id = uuid();
  const bytes = byteLength(body);
  const inline = bytes <= INLINE_CUTOFF_BYTES;

  let ref_path: string | null = null;
  let inline_body: string | null = null;

  if (inline) {
    inline_body = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  } else {
    const suffix = ext ? `.${ext.replace(/^\./, "")}` : "";
    ref_path = `${id}${suffix}`;
    const abs = join(artifactsDir(), ref_path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  db.run(
    "INSERT INTO artifacts (uuid, kind, ref_path, inline_body, bytes, originating_row_id) VALUES (?, ?, ?, ?, ?, ?)",
    [id, kind, ref_path, inline_body, bytes, originating_row_id],
  );
  return id;
}

export function readArtifact(db: Database, uuid: string): Artifact | null {
  const row = db
    .query<Artifact, [string]>(
      "SELECT uuid, kind, ref_path, inline_body, bytes FROM artifacts WHERE uuid=?",
    )
    .get(uuid);
  return row ?? null;
}

export function absolutePath(ref_path: string): string {
  return join(artifactsDir(), ref_path);
}
