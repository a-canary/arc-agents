import { test, expect, describe } from "bun:test";
import { gaps, type MissionGoal, type LedgerRow, type Gap } from "./mission-gap";

const goal = (id: string, title = `title-${id}`): MissionGoal => ({ id, title });
const row = (goalId: string | undefined, state: string): LedgerRow => ({ goalId, state });

const COVERING = ["ready", "claimed", "wip", "review", "blocked", "merged"];
const NONCOVERING = ["cancelled", "failed"];

describe("mission-gap gaps()", () => {
  test("empty goals → []", () => {
    expect(gaps([], [])).toEqual([]);
    expect(gaps([], [row("g1", "merged")])).toEqual([]);
  });

  test("empty ledger → every goal is a gap (no-work reason)", () => {
    const result = gaps([goal("g1"), goal("g2")], []);
    expect(result).toEqual([
      { goalId: "g1", title: "title-g1", reason: "no active ledger work linked to this goal" },
      { goalId: "g2", title: "title-g2", reason: "no active ledger work linked to this goal" },
    ]);
  });

  for (const s of COVERING) {
    test(`covering state "${s}" → no gap`, () => {
      expect(gaps([goal("g1")], [row("g1", s)])).toEqual([]);
    });
  }

  for (const s of NONCOVERING) {
    test(`only "${s}" linked → gap with cancelled/failed reason`, () => {
      expect(gaps([goal("g1")], [row("g1", s)])).toEqual([
        { goalId: "g1", title: "title-g1", reason: "only cancelled/failed work linked to this goal" },
      ]);
    });
  }

  test("goal with zero linked rows (other goals have work) → no-work reason", () => {
    const result = gaps([goal("g1"), goal("g2")], [row("g2", "wip")]);
    expect(result).toEqual([
      { goalId: "g1", title: "title-g1", reason: "no active ledger work linked to this goal" },
    ]);
  });

  test("cancelled AND merged on same goal → COVERED (merged counts), no gap", () => {
    expect(gaps([goal("g1")], [row("g1", "cancelled"), row("g1", "merged")])).toEqual([]);
  });

  test("failed AND ready → covered", () => {
    expect(gaps([goal("g1")], [row("g1", "failed"), row("g1", "ready")])).toEqual([]);
  });

  test("duplicate goalIds in ledger → no double counting, covered once", () => {
    expect(gaps([goal("g1")], [row("g1", "wip"), row("g1", "wip"), row("g1", "review")])).toEqual([]);
  });

  test("rows with undefined goalId are ignored", () => {
    const result = gaps([goal("g1")], [row(undefined, "merged"), row("g2", "merged")]);
    expect(result).toEqual([
      { goalId: "g1", title: "title-g1", reason: "no active ledger work linked to this goal" },
    ]);
  });

  test("output order = input goal order", () => {
    const result = gaps([goal("z"), goal("a"), goal("m")], []);
    expect(result.map((g: Gap) => g.goalId)).toEqual(["z", "a", "m"]);
  });

  test("default cap = 5: 7 uncovered goals → 5 gaps, first 5 in order", () => {
    const goals = ["a", "b", "c", "d", "e", "f", "g"].map((id) => goal(id));
    const result = gaps(goals, []);
    expect(result).toHaveLength(5);
    expect(result.map((g: Gap) => g.goalId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("explicit cap 3: 7 uncovered → 3 gaps, first 3 in order", () => {
    const goals = ["a", "b", "c", "d", "e", "f", "g"].map((id) => goal(id));
    const result = gaps(goals, [], { maxProposals: 3 });
    expect(result.map((g: Gap) => g.goalId)).toEqual(["a", "b", "c"]);
  });

  test("cap 0 → []", () => {
    expect(gaps([goal("a"), goal("b")], [], { maxProposals: 0 })).toEqual([]);
  });

  test("negative cap → default 5", () => {
    const goals = ["a", "b", "c", "d", "e", "f", "g"].map((id) => goal(id));
    expect(gaps(goals, [], { maxProposals: -3 })).toHaveLength(5);
  });

  test("undefined cap (opts present, no maxProposals) → default 5", () => {
    const goals = ["a", "b", "c", "d", "e", "f", "g"].map((id) => goal(id));
    expect(gaps(goals, [], {})).toHaveLength(5);
  });

  test("cap larger than uncovered count → all uncovered", () => {
    expect(gaps([goal("a"), goal("b")], [], { maxProposals: 99 })).toHaveLength(2);
  });

  test("truncation skips covered goals before counting toward cap", () => {
    // g2 covered; uncovered are g1,g3,g4,g5; cap 2 → first two uncovered (g1,g3)
    const goals = [goal("g1"), goal("g2"), goal("g3"), goal("g4"), goal("g5")];
    const result = gaps(goals, [row("g2", "merged")], { maxProposals: 2 });
    expect(result.map((g: Gap) => g.goalId)).toEqual(["g1", "g3"]);
  });
});
