import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import {
  tierRank,
  poolRank,
  compareBySortKey,
  TIER_RANK,
  POOL_RANK,
  TIER_VALUES,
  POOL_VALUES,
  SORT_KEY_SQL,
  type SortRow,
} from "./tier-pool-sort";

describe("tierRank — ordering", () => {
  test("prod < trust < mvp < quality < scale < efficiency < hygiene < tier_unset", () => {
    expect(tierRank("prod")).toBeLessThan(tierRank("trust"));
    expect(tierRank("trust")).toBeLessThan(tierRank("mvp"));
    expect(tierRank("mvp")).toBeLessThan(tierRank("quality"));
    expect(tierRank("quality")).toBeLessThan(tierRank("scale"));
    expect(tierRank("scale")).toBeLessThan(tierRank("efficiency"));
    expect(tierRank("efficiency")).toBeLessThan(tierRank("hygiene"));
    expect(tierRank("hygiene")).toBeLessThan(tierRank("tier_unset"));
  });

  test("unknown tier returns 999", () => {
    expect(tierRank("nonsense")).toBe(999);
  });

  test("all TIER_VALUES have a defined rank in TIER_RANK", () => {
    for (const t of TIER_VALUES) {
      expect(TIER_RANK[t]).toBeDefined();
    }
  });
});

describe("poolRank — ordering", () => {
  test("interactive < ops < build < explore < pool_unset", () => {
    expect(poolRank("interactive")).toBeLessThan(poolRank("ops"));
    expect(poolRank("ops")).toBeLessThan(poolRank("build"));
    expect(poolRank("build")).toBeLessThan(poolRank("explore"));
    expect(poolRank("explore")).toBeLessThan(poolRank("pool_unset"));
  });

  test("unknown pool returns 999", () => {
    expect(poolRank("nonsense")).toBe(999);
  });

  test("all POOL_VALUES have a defined rank in POOL_RANK", () => {
    for (const p of POOL_VALUES) {
      expect(POOL_RANK[p]).toBeDefined();
    }
  });
});

describe("compareBySortKey — tier-MAJOR, pool-MINOR", () => {
  test("tier dominates pool: tier_unset+interactive sorts AFTER prod+pool_unset", () => {
    const rows: SortRow[] = [
      { id: "a", tier: "tier_unset", pool: "interactive", created_at: 1 },
      { id: "b", tier: "prod", pool: "pool_unset", created_at: 2 },
    ];
    rows.sort(compareBySortKey);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  test("pool breaks tie within same tier", () => {
    const rows: SortRow[] = [
      { id: "a", tier: "mvp", pool: "explore", created_at: 1 },
      { id: "b", tier: "mvp", pool: "interactive", created_at: 2 },
      { id: "c", tier: "mvp", pool: "build", created_at: 3 },
    ];
    rows.sort(compareBySortKey);
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  test("created_at FIFO within (tier, pool)", () => {
    const rows: SortRow[] = [
      { id: "z", tier: "mvp", pool: "build", created_at: 300 },
      { id: "y", tier: "mvp", pool: "build", created_at: 100 },
      { id: "x", tier: "mvp", pool: "build", created_at: 200 },
    ];
    rows.sort(compareBySortKey);
    expect(rows.map((r) => r.id)).toEqual(["y", "x", "z"]);
  });

  test("id breaks final tie", () => {
    const rows: SortRow[] = [
      { id: "b", tier: "mvp", pool: "build", created_at: 1 },
      { id: "a", tier: "mvp", pool: "build", created_at: 1 },
    ];
    rows.sort(compareBySortKey);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("tier_unset sinks to bottom of its pool band", () => {
    const rows: SortRow[] = [
      { id: "u", tier: "tier_unset", pool: "interactive", created_at: 1 },
      { id: "e", tier: "efficiency", pool: "interactive", created_at: 2 },
      { id: "p", tier: "prod", pool: "build", created_at: 3 },
    ];
    rows.sort(compareBySortKey);
    // prod/build (0,2) sorts first, then efficiency/interactive (5,0), then tier_unset/interactive (99,0)
    expect(rows.map((r) => r.id)).toEqual(["p", "e", "u"]);
  });
});

test("SORT_KEY_SQL contains CASE tier and CASE pool", () => {
  expect(SORT_KEY_SQL).toContain("CASE tier");
  expect(SORT_KEY_SQL).toContain("CASE pool");
  expect(SORT_KEY_SQL).toContain("created_at");
  expect(SORT_KEY_SQL).toContain("id");
});

test("SQL fragment orders rows correctly (tier-MAJOR) in a live query", () => {
  const db = new Database(":memory:");
  migrate(db);
  const ins = (id: string, tier: string, pool: string, created_at: number) =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, created_at)
       VALUES (?, 'p', 't', 'b', 'mvp', 'ready', 'task', ?, ?, ?)`,
      [id, tier, pool, created_at],
    );

  ins("prod-ops", "prod", "ops", 100);
  ins("mvp-interactive", "mvp", "interactive", 200);
  ins("mvp-build-early", "mvp", "build", 100);
  ins("mvp-build-late", "mvp", "build", 300);
  ins("tier_unset-interactive", "tier_unset", "interactive", 50);
  ins("hygiene-pool_unset", "hygiene", "pool_unset", 1);

  const sorted = db
    .query<{ id: string }, []>(`SELECT id FROM issues ORDER BY ${SORT_KEY_SQL}`)
    .all()
    .map((r) => r.id);

  // prod(0) first, then mvp(2): interactive(0) before build(2), early before late.
  // then hygiene(6), then tier_unset(99)
  expect(sorted).toEqual([
    "prod-ops",
    "mvp-interactive",
    "mvp-build-early",
    "mvp-build-late",
    "hygiene-pool_unset",
    "tier_unset-interactive",
  ]);
});
