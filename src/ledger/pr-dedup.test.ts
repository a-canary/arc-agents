import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrDuplicate,
  fetchOpenPrs,
  getOpenPrIndex,
  slugForProject,
  defaultCmdRunner,
  type GhRunner,
  type OpenPr,
} from "./pr-dedup";

const scratch = () => join(mkdtempSync(join(tmpdir(), "pr-dedup-")), "index.json");

const ghOk = (payload: unknown): GhRunner => () => ({ ok: true, out: JSON.stringify(payload) });
const ghFail: GhRunner = () => ({ ok: false, out: "gh: not authenticated" });

// ── checkPrDuplicate (pure) ──────────────────────────────────────────────────

test("flags an open PR sharing a source path with the candidate", () => {
  const prs: OpenPr[] = [
    { number: 490, title: "relocate fixture", files: ["bin/write-lane-gate.test.ts"] },
  ];
  const hits = checkPrDuplicate("fix the gate\nsee bin/write-lane-gate.test.ts", prs);
  expect(hits).toEqual([
    { prNumber: 490, prTitle: "relocate fixture", sharedPaths: ["bin/write-lane-gate.test.ts"] },
  ]);
});

// The incident that motivated this ticket: PR #490 and PR #495 were both open
// against one defect in bin/write-lane-gate.test.ts. A third ticket naming the
// same file must surface BOTH, even though all three titles are dissimilar.
test("reproduces #490/#495: third ticket surfaces both open PRs", () => {
  const prs: OpenPr[] = [
    { number: 490, title: "relocate the fixture outside every allowlist prefix", files: ["bin/write-lane-gate.test.ts"] },
    { number: 495, title: "re-anchor $HOME so ~-prefixes stop covering it", files: ["bin/write-lane-gate.test.ts", "bin/write-lane-gate.ts"] },
    { number: 501, title: "unrelated docs pass", files: ["README.md"] },
  ];
  const hits = checkPrDuplicate(
    "fix write-lane-gate out-of-lane fixture\nThe failing test is in bin/write-lane-gate.test.ts",
    prs,
  );
  expect(hits.map((h) => h.prNumber)).toEqual([490, 495]);
});

test("does not flag a PR with no path overlap", () => {
  const prs: OpenPr[] = [{ number: 1, title: "docs", files: ["README.md"] }];
  expect(checkPrDuplicate("touch src/ledger/db.ts", prs)).toEqual([]);
});

test("candidate naming no paths yields no hits", () => {
  const prs: OpenPr[] = [{ number: 1, title: "docs", files: ["README.md"] }];
  expect(checkPrDuplicate("make the thing faster", prs)).toEqual([]);
});

test("path matching is case-insensitive on both sides", () => {
  const prs: OpenPr[] = [{ number: 7, title: "x", files: ["Bin/Write-Lane-Gate.test.ts"] }];
  expect(checkPrDuplicate("see bin/write-lane-gate.TEST.ts", prs)).toHaveLength(1);
});

// ── fetchOpenPrs ─────────────────────────────────────────────────────────────

test("fetchOpenPrs maps gh json into OpenPr records", () => {
  const runner = ghOk([{ number: 3, title: "t", files: [{ path: "a/b.ts" }, { path: "c/d.ts" }] }]);
  expect(fetchOpenPrs("o/r", runner)).toEqual([{ number: 3, title: "t", files: ["a/b.ts", "c/d.ts"] }]);
});

test("fetchOpenPrs returns null when gh fails", () => {
  expect(fetchOpenPrs("o/r", ghFail)).toBeNull();
});

test("fetchOpenPrs returns null on unparseable output", () => {
  expect(fetchOpenPrs("o/r", () => ({ ok: true, out: "not json" }))).toBeNull();
});

// ── getOpenPrIndex (cache) ───────────────────────────────────────────────────

test("first call fetches and writes the cache file", () => {
  const cachePath = scratch();
  let calls = 0;
  const runner: GhRunner = (a) => { calls++; return ghOk([{ number: 1, title: "t", files: [{ path: "a/b.ts" }] }])(a); };
  const prs = getOpenPrIndex("o/r", { cachePath, runner, now: 1000 });
  expect(prs).toEqual([{ number: 1, title: "t", files: ["a/b.ts"] }]);
  expect(calls).toBe(1);
  expect(existsSync(cachePath)).toBe(true);
});

test("second call inside the TTL serves the cache without touching gh", () => {
  const cachePath = scratch();
  let calls = 0;
  const runner: GhRunner = (a) => { calls++; return ghOk([{ number: 1, title: "t", files: [{ path: "a/b.ts" }] }])(a); };
  getOpenPrIndex("o/r", { cachePath, runner, now: 1000, ttlSec: 900 });
  const second = getOpenPrIndex("o/r", { cachePath, runner, now: 1500, ttlSec: 900 });
  expect(calls).toBe(1);
  expect(second).toHaveLength(1);
});

test("a call past the TTL refetches", () => {
  const cachePath = scratch();
  let calls = 0;
  const runner: GhRunner = (a) => { calls++; return ghOk([{ number: calls, title: "t", files: [] }])(a); };
  getOpenPrIndex("o/r", { cachePath, runner, now: 1000, ttlSec: 900 });
  const second = getOpenPrIndex("o/r", { cachePath, runner, now: 2000, ttlSec: 900 });
  expect(calls).toBe(2);
  expect(second![0]!.number).toBe(2);
});

test("gh failure with a stale cache serves the stale index", () => {
  const cachePath = scratch();
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: 0, prs: [{ number: 9, title: "old", files: ["a/b.ts"] }] }));
  const prs = getOpenPrIndex("o/r", { cachePath, runner: ghFail, now: 999999 });
  expect(prs).toEqual([{ number: 9, title: "old", files: ["a/b.ts"] }]);
});

test("gh failure with no cache returns null, not an empty all-clear", () => {
  expect(getOpenPrIndex("o/r", { cachePath: scratch(), runner: ghFail, now: 1000 })).toBeNull();
});

test("a corrupt cache file is refetched over, not thrown on", () => {
  const cachePath = scratch();
  writeFileSync(cachePath, "{{{ not json");
  const prs = getOpenPrIndex("o/r", {
    cachePath, now: 1000,
    runner: ghOk([{ number: 4, title: "t", files: [] }]),
  });
  expect(prs![0]!.number).toBe(4);
  expect(JSON.parse(readFileSync(cachePath, "utf8")).fetchedAt).toBe(1000);
});

// ── slugForProject ───────────────────────────────────────────────────────────

test("slugForProject parses an ssh origin url", () => {
  const slug = slugForProject("arc-agents", () => ({ ok: true, out: "git@github.com:a-canary/arc-agents.git" }));
  expect(slug).toBe("a-canary/arc-agents");
});

test("slugForProject parses an https origin url", () => {
  const slug = slugForProject("arc-agents", () => ({ ok: true, out: "https://github.com/a-canary/arc-agents" }));
  expect(slug).toBe("a-canary/arc-agents");
});

test("slugForProject returns null when the repo has no origin", () => {
  expect(slugForProject("nope", () => ({ ok: false, out: "" }))).toBeNull();
});

// The advisory runs on the synchronous create path: a command that never
// returns must not stall the insert. Fails (hangs) if the spawn timeout goes.
test("defaultCmdRunner gives up on a hanging command instead of blocking", () => {
  const started = Date.now();
  const r = defaultCmdRunner("sleep", ["120"]);
  expect(r.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(30_000);
}, 40_000);
