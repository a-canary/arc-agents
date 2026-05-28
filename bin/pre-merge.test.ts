import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = process.cwd() + "/bin/pre-merge.sh";

// Extract a gate function body using nesting-aware brace matching.
function extractFn(name: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  const re = new RegExp(`^${name}\\(\\) \\{\n`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`function ${name} not found in ${SCRIPT}`);
  let depth = 1;
  let i = m.index! + m[0].length;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{" && src[i - 1] !== "'") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return src.slice(m.index!, i);
}

// Run gate_merge_gate by sourcing the function against a stub merge-gate.sh.
function runGate(stubBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pre-merge-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "merge-gate.sh");
  writeFileSync(stub, `#!/bin/bash\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  const fnBody = extractFn("gate_merge_gate");
  const driver = [
    `BIN='${bin}'`,
    `PROJECT='${dir}'`,
    `pass() { echo "PASS:$1:$2"; }`,
    `fail() { echo "FAIL:$1:$2"; }`,
    `skip() { echo "SKIP:$1:$2"; }`,
    `log() { :; }`,
    fnBody,
    `gate_merge_gate`,
  ].join("\n");
  const res = spawnSync("bash", ["-c", driver], { encoding: "utf8" });
  return res.stdout + res.stderr;
}

// TS re-implementation of gate_api_key_guard patterns for unit testing.
// This mirrors the grep patterns from pre-merge.sh gate_api_key_guard:
//   - bare csk-/sk- key strings ≥20 chars
//   - os.environ.get / os.getenv with empty-string default
//   - key field "keyname": "16+char" in JSON/YAML
//   - API_KEY = "" / = ''  assignments
function runApiKeyGuard(stagedLines: readonly string[]): string {
  for (const raw of stagedLines) {
    const line = raw.replace(/^\+/, "");
    if (!line.trim()) continue;

    // Pattern 1: bare key strings (csk-/sk- prefix, 20+ alphanumeric chars)
    if (/'(csk-[A-Za-z0-9]{20,})'/.test(line) ||
        /"(csk-[A-Za-z0-9]{20,})"/.test(line) ||
        /'(sk-[A-Za-z0-9]{20,})'/.test(line) ||
        /"(sk-[A-Za-z0-9]{20,})"/.test(line)) {
      return "FAIL:api-key-guard: bare API key string found";
    }

    // Pattern 2: os.environ.get / os.getenv with empty-string default
    if (/os\.environ\.get\([^)]*,\s*''\)/.test(line) ||
        /os\.environ\.get\([^)]*,\s*""\)/.test(line) ||
        /os\.getenv\([^)]*,\s*''\)/.test(line) ||
        /os\.getenv\([^)]*,\s*""\)/.test(line)) {
      return "FAIL:api-key-guard: empty env-var default (silent fail)";
    }

    // Pattern 3: key field with 16+ char plain-text value in JSON/YAML
    if (/"[a-z_-]{0,20}key[a-z_-]{0,20}"\s*:\s*"[A-Za-z0-9]{16,}"/.test(line)) {
      return "FAIL:api-key-guard: plain-text API key in config";
    }

    // Pattern 4: empty string API_KEY assignment
    if (/(?:API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|CEREBRAS_API_KEY)\s*=\s*""/.test(line) ||
        /(?:API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|CEREBRAS_API_KEY)\s*=\s*''/.test(line)) {
      return "FAIL:api-key-guard: empty API_KEY assignment";
    }
  }
  return stagedLines.length > 0
    ? "PASS:api-key-guard"
    : "SKIP:api-key-guard";
}

describe("pre-merge.sh gate_merge_gate", () => {
  test("PASS when merge-gate.sh exits 0", () => {
    expect(runGate("exit 0")).toContain("PASS:merge-gate");
  });

  test("FAIL with bun install hint when typecheck shows 'tsc: command not found'", () => {
    const out = runGate(
      "echo 'src/foo.ts: tsc: command not found' >&2; exit 1"
    );
    expect(out).toContain("FAIL:merge-gate");
    expect(out).toContain("bun install");
  });

  test("FAIL without bun install hint for unrelated failure", () => {
    const out = runGate("echo 'real test failure' >&2; exit 1");
    expect(out).toContain("FAIL:merge-gate");
    expect(out).not.toContain("bun install");
  });
});

describe("pre-merge.sh gate_api_key_guard", () => {
  // Gate patterns (from pre-merge.sh gate_api_key_guard source):
  //   1. bare csk-/sk- key strings ≥20 chars  ✓
  //   2. os.environ.get / os.getenv empty-string default  ✓
  //   3. JSON key field with 16+ char plain-text value  ✓
  //   4. API_KEY = "" / = '' empty assignment  ✓
  // TS re-implementation above mirrors the bash patterns exactly.
  // gate_merge_gate tests above use the real bash function (no || chains).

  test("SKIP when no staged additions", () => {
    expect(runApiKeyGuard([])).toContain("SKIP:api-key-guard");
  });

  test("PASS on code with no key patterns", () => {
    const out = runApiKeyGuard([
      "+ client = fetch_data(url)",
      "+ result = process_response(data)",
    ]);
    expect(out).toContain("PASS:api-key-guard");
  });

  test("FAIL on bare csk- key string (single-quoted, 20+ chars)", () => {
    const out = runApiKeyGuard([
      "+key = 'csk-hpr4pjyd895p4ktvpnn436exx49rr925f6dptjvmee5ycrx8'",
    ]);
    expect(out).toContain("FAIL:api-key-guard");
  });

  test("FAIL on bare sk- key string (double-quoted, 20+ chars)", () => {
    const out = runApiKeyGuard([
      '+key = "sk-PROJABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop"',
    ]);
    expect(out).toContain("FAIL:api-key-guard");
  });

  test("FAIL on os.environ.get with empty-string default", () => {
    const out = runApiKeyGuard(["+api_key = os.environ.get('API_KEY', '')"]);
    expect(out).toContain("FAIL:api-key-guard");
    expect(out).toContain("empty env-var default");
  });

  test("FAIL on os.getenv with empty-string default", () => {
    const out = runApiKeyGuard([
      'ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")',
    ]);
    expect(out).toContain("FAIL:api-key-guard");
    expect(out).toContain("empty env-var default");
  });

  test("FAIL on plain-text key field in JSON/YAML", () => {
    const out = runApiKeyGuard([
      '"api_key": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",',
    ]);
    expect(out).toContain("FAIL:api-key-guard");
    expect(out).toContain("plain-text API key");
  });

  test("FAIL on API_KEY = \"\" assignment", () => {
    const out = runApiKeyGuard(['API_KEY = ""']);
    expect(out).toContain("FAIL:api-key-guard");
    expect(out).toContain("empty API_KEY");
  });

  test("FAIL on CEREBRAS_API_KEY = '' assignment", () => {
    const out = runApiKeyGuard(["CEREBRAS_API_KEY = ''"]);
    expect(out).toContain("FAIL:api-key-guard");
  });

  test("PASS on os.environ.get with non-empty fallback", () => {
    const out = runApiKeyGuard([
      '+key = os.environ.get("API_KEY", "/default/path")',
    ]);
    expect(out).toContain("PASS:api-key-guard");
  });

  test("PASS on os.getenv with no default (required-var pattern)", () => {
    const out = runApiKeyGuard([
      "ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY')",
    ]);
    expect(out).toContain("PASS:api-key-guard");
  });

  test("PASS on too-short key-like string (avoids pre-key false positive)", () => {
    // "csk-" prefix but only 15 chars — below the 20-char min threshold
    const out = runApiKeyGuard(["# comment containing csk-too-short"]);
    expect(out).toContain("PASS:api-key-guard");
  });
});
