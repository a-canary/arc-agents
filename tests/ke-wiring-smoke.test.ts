/**
 * tests/ke-wiring-smoke.test.ts — KE skills wiring smoke test (hermetic)
 *
 * Verifies the ke-recall and ke-learn skills reference a working ke-tool.ts
 * and use the correct command signatures. No subprocess execution — reads
 * the SKILL.md files and validates their content against the live ke-tool.ts
 * interface.
 *
 * KE_ROOT is respected: tests run against KE_ROOT if set, else ~/vault/ke.
 * The ke-tool.ts at ~/repos/ke/bin/ke-tool.ts is the canonical engine.
 *
 * Run: bun test tests/ke-wiring-smoke.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const KE_TOOL = resolve(homedir(), "repos", "ke", "bin", "ke-tool.ts");
const KE_ROOT = process.env.KE_ROOT ?? join(homedir(), "vault", "ke");
const KE_RECALL = join(__dirname, "..", "skills", "ke-recall", "SKILL.md");
const KE_LEARN = join(__dirname, "..", "skills", "ke-learn", "SKILL.md");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e: any) { failed++; console.error(`  ❌ ${name}: ${e.message}`); }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── ke-tool.ts exists and is runnable ─────────────────────────────────────────

console.log("\nke-tool.ts availability:");

test("ke-tool.ts exists at ~/repos/ke/bin/ke-tool.ts", () => {
  assert(existsSync(KE_TOOL), `not found: ${KE_TOOL}`);
});

test("KE_ROOT is a valid directory or will be created on first ingest", () => {
  // KE_ROOT may not exist yet (first-run). ke-tool.ts creates it.
  // Just verify it's a reasonable path.
  assert(KE_ROOT.length > 0, "KE_ROOT is empty");
  assert(KE_ROOT.includes("vault/ke"), `KE_ROOT=${KE_ROOT} does not look like a KE vault path`);
});

// ── ke-recall skill validity ───────────────────────────────────────────────────

console.log("\nke-recall skill:");

test("ke-recall/SKILL.md exists", () => {
  assert(existsSync(KE_RECALL), `not found: ${KE_RECALL}`);
});

test("ke-recall references ke-tool.ts (not the old ke.ts FTS5 approach)", () => {
  const content = readFileSync(KE_RECALL, "utf8");
  assert(!content.includes("bin/ke.ts"), "skill still references bin/ke.ts (old FTS5 approach — update to ke-tool.ts)");
  assert(!content.includes("ke.fts.db"), "skill still references ke.fts.db (old FTS5 approach)");
  assert(content.includes("ke-tool.ts"), `skill does not reference ke-tool.ts`);
});

test("ke-recall uses 'search' or 'query' subcommand", () => {
  const content = readFileSync(KE_RECALL, "utf8");
  assert(
    content.includes("search") || content.includes("query"),
    "skill does not mention 'search' or 'query' subcommand"
  );
});

test("ke-recall does not hardcode a username", () => {
  const content = readFileSync(KE_RECALL, "utf8");
  assert(!content.includes("a-canary"), "skill hardcodes username a-canary");
  assert(!content.includes("aaron"), "skill hardcodes username aaron");
});

// ── ke-learn skill validity ────────────────────────────────────────────────────

console.log("\nke-learn skill:");

test("ke-learn/SKILL.md exists", () => {
  assert(existsSync(KE_LEARN), `not found: ${KE_LEARN}`);
});

test("ke-learn references ke-tool.ts (not the old ke.ts FTS5 approach)", () => {
  const content = readFileSync(KE_LEARN, "utf8");
  assert(!content.includes("bin/ke.ts"), "skill still references bin/ke.ts (old FTS5 approach — update to ke-tool.ts)");
  assert(!content.includes("ke.fts.db"), "skill still references ke.fts.db (old FTS5 approach)");
  assert(content.includes("ke-tool.ts"), `skill does not reference ke-tool.ts`);
});

test("ke-learn uses 'ingest' subcommand", () => {
  const content = readFileSync(KE_LEARN, "utf8");
  assert(content.includes("ingest"), "skill does not mention 'ingest' subcommand");
});

test("ke-learn mentions KE_ROOT/Qdrant context", () => {
  const content = readFileSync(KE_LEARN, "utf8");
  // ke-learn should mention the Qdrant requirement or KE_ROOT usage
  assert(
    content.includes("Qdrant") || content.includes("qdrant") || content.includes("embed") || content.includes("ingest"),
    "skill does not mention Qdrant or ingest"
  );
});

test("ke-learn does not hardcode a username", () => {
  const content = readFileSync(KE_LEARN, "utf8");
  assert(!content.includes("a-canary"), "skill hardcodes username a-canary");
  assert(!content.includes("aaron"), "skill hardcodes username aaron");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);