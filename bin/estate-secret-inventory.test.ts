import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture repo with a planted fake key in an old commit — the scanner must
// report repo, commit, and fingerprint (matches PRD acceptance test).
test("estate-secret-inventory finds a planted secret in git history", () => {
  const root = mkdtempSync(join(tmpdir(), "sec-inv-root-"));
  const repo = join(root, "fixture-repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  // synthetic, not a real credential: random hex, never a valid provider key,
  // but high-entropy enough to trip gitleaks' generic-api-key rule.
  const fakeKey = "sk-or-v1-" + Array.from({ length: 64 }, (_, i) => ((i * 2654435761) % 16).toString(16)).join("");
  writeFileSync(join(repo, ".env"), `OPENROUTER_API_KEY=${fakeKey}\n`);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "leak"]);
  // fixed forward, but the leak stays live in history — this is the case
  // the scanner exists to catch.
  writeFileSync(join(repo, ".env"), "OPENROUTER_API_KEY=REDACTED\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "rotate"]);

  const scriptPath = join(import.meta.dir, "estate-secret-inventory.ts");
  let out = "";
  try {
    out = execFileSync("bun", [scriptPath, root], { encoding: "utf8" });
  } catch (e: any) {
    out = e.stdout; // non-zero exit is expected when findings exist
  }
  const result = JSON.parse(out);
  expect(result.scanned).toBe(1);
  expect(result.findings.length).toBeGreaterThan(0);
  const f = result.findings[0];
  expect(f.repo).toContain("fixture-repo");
  expect(typeof f.commit).toBe("string");
  expect(f.commit.length).toBeGreaterThan(0);
  expect(typeof f.fingerprint).toBe("string");
  expect(f.fingerprint.length).toBeGreaterThan(0);

  rmSync(root, { recursive: true, force: true });
});
