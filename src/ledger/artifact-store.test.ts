import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPath, artifactRoot, storeArtifact } from "./artifact-store";

let tmp: string;
const prev = process.env.ARC_ARTIFACT_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "artstore-"));
  process.env.ARC_ARTIFACT_ROOT = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (prev === undefined) delete process.env.ARC_ARTIFACT_ROOT;
  else process.env.ARC_ARTIFACT_ROOT = prev;
});

describe("artifact-store", () => {
  test("storeArtifact writes file at sha256.<ext> and returns hash", () => {
    const { sha256, ext, path } = storeArtifact("hello world", "txt");
    expect(sha256).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(ext).toBe("txt");
    expect(path).toBe(join(tmp, `${sha256}.txt`));
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  test("idempotent: second store of same bytes does not rewrite", () => {
    const a = storeArtifact("payload", "md");
    const mtime1 = statSync(a.path).mtimeMs;
    // sleep a bit so mtime would change if rewritten
    const until = Date.now() + 20;
    while (Date.now() < until) {}
    const b = storeArtifact("payload", "md");
    expect(b.sha256).toBe(a.sha256);
    expect(b.path).toBe(a.path);
    expect(statSync(a.path).mtimeMs).toBe(mtime1);
  });

  test("artifactPath validates sha256 and ext", () => {
    expect(() => artifactPath("nothex", "txt")).toThrow();
    expect(() => artifactPath("a".repeat(64), "bad/ext")).toThrow();
    const ok = artifactPath("a".repeat(64), ".PNG");
    expect(ok).toBe(join(tmp, `${"a".repeat(64)}.png`));
  });

  test("binary bytes round-trip", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    const { path } = storeArtifact(bytes, "bin");
    expect(existsSync(path)).toBe(true);
    expect(Array.from(readFileSync(path))).toEqual([0, 1, 2, 255, 254]);
  });

  test("artifactRoot honors env override", () => {
    expect(artifactRoot()).toBe(tmp);
  });
});
