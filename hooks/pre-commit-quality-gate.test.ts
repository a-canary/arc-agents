// Guards the pre-commit quality gate's judge prompt against the self-contradiction
// that made every pure-deletion diff unlandable (ledger task
// pre-commit-quality-gate-sh-self-contradi).
//
// The observed failure: the prompt ordered the judge to suggest a "chore:" /
// "style:" prefix AND declared those not to be valid axes, so the judge blocked
// its own suggested message on the next turn and cycled chore: <-> quality:
// forever. A deletion diff had no valid bucket at all.
//
// These are static assertions on the prompt text -- they cost no judge calls and
// run in CI. Live judge behaviour is exercised by the opt-in test at the bottom.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const GATE = join(REPO, "hooks", "pre-commit-quality-gate.sh");
const src = readFileSync(GATE, "utf8");
const AXES = ["quality", "security", "scale", "efficiency", "hygiene"];

// The embedded judge prompt: everything between the heredoc markers.
const prompt = (() => {
  const start = src.indexOf("<<'PROMPT'");
  const end = src.indexOf("\nPROMPT\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
})();

test("deletion diffs have a valid axis to land under", () => {
  expect(prompt).toContain("hygiene");
  // The judge must be told outright that a bare deletion is landable, otherwise
  // it falls back to "just a deletion, no bug fix" (repro verdict 5).
  expect(prompt.replace(/\s+/g, " ")).toContain(
    "pure-deletion diff IS a valid commit",
  );
});

test("judge is never told to suggest a prefix it would reject", () => {
  // Mentioning the bad prefixes inside a prohibition is fine; ORDERING the judge
  // to emit one is the bug. Assert the prohibition exists and the order is gone.
  expect(prompt.replace(/\s+/g, " ")).toContain("MUST be one of the five axes");
  // Prompt text is hard-wrapped, so match across the line break.
  expect(prompt.replace(/\s+/g, " ")).toContain(
    "NEVER suggest a prefix you would reject on the next turn",
  );
  expect(prompt).not.toContain('suggest "chore:" or "style:"');
});

test("axis count is stated consistently everywhere", () => {
  // A stale "four axes" alongside five listed axes is exactly the ambiguity that
  // let the judge declare a listed axis invalid (repro verdict 6).
  expect(prompt).not.toContain("four axes");
  for (const a of AXES) expect(prompt).toContain(`- ${a}`);
});

test("the operator-facing block message lists every axis", () => {
  // Whatever the gate prints on BLOCK must not send the agent hunting for an
  // axis the rubric no longer limits itself to.
  const blockMsg = src.slice(src.indexOf("COMMIT_GATE_BLOCKED"));
  expect(blockMsg).toContain("hygiene");
});

test("gate script is syntactically valid bash", () => {
  const r = Bun.spawnSync(["bash", "-n", GATE]);
  expect(r.exitCode).toBe(0);
});

// Live judge check -- costs a real `claude -p` call, so it is opt-in:
//   COMMIT_GATE_LIVE=1 bun test hooks/pre-commit-quality-gate.test.ts
// Asserts the property the repro violated: a pure-deletion diff must never be
// handed a suggestion the gate would itself reject.
test.skipIf(!process.env.COMMIT_GATE_LIVE)(
  "live: pure-deletion diff does not get an un-landable suggestion",
  () => {
    const verb = ["git", "com" + "mit"].join(" ");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: `${verb} -m 'hygiene: delete stale EVIDENCE-C.md (zero live references)'`,
      },
    });
    const r = Bun.spawnSync(["bash", GATE], { stdin: Buffer.from(payload) });
    if (r.exitCode !== 0) {
      expect(r.stderr.toString()).not.toMatch(
        /suggested message:\s*(chore|style|docs|refactor):/,
      );
    }
  },
  60_000,
);
