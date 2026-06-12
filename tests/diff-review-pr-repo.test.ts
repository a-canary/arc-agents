// Documents the pr_url → owner/repo extraction used by the diff-review
// project's 3-line bash check (see roles/overlays/diff-review.md +
// skills/diff-review/SKILL.md). Mirrors the sed regex in shell so a
// regression in the regex semantics surfaces here even if the
// markdown snippets drift.
import { test, expect } from "bun:test";

const extractRepo = (url: string): string | null =>
  url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? null;

test("github PR URL extracts owner/repo (matches the bash sed -E regex)", () => {
  expect(extractRepo("https://github.com/a-canary/cli-proxy/pull/1")).toBe("a-canary/cli-proxy");
});
