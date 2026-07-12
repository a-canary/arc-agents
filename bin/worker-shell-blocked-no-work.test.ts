// Final reconcile branch: when every candidate engine produces no work, the
// row must go `blocked` with an `engine-alias-no-work:<alias>` reason — not
// `failed`. This is an engine-infrastructure outage (e.g. MiniMax billing
// lapse), not a task defect; `failed` stays reserved for task-attributable
// errors. See reconcile-no-work-outages-as-blocked-aut.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh"),
  "utf8",
);

function finalBranch(): string {
  const marker = "# Every candidate exhausted";
  const idx = SCRIPT.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  return SCRIPT.slice(idx, SCRIPT.indexOf("\n\n", idx));
}

test("all-candidates-exhausted branch transitions to blocked, not failed", () => {
  const branch = finalBranch();
  expect(branch).toContain("--state blocked");
  expect(branch).not.toContain("--state failed");
});

test("all-candidates-exhausted branch embeds engine-alias-no-work:<alias> reason", () => {
  const branch = finalBranch();
  expect(branch).toContain("engine-alias-no-work:${ALIAS}");
});
