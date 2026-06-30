import { test, expect, describe } from "bun:test";
import {
  brief,
  type GitLogEntry,
  type LedgerRow,
  type FeedbackRow,
  type BriefItem,
} from "./director-brief";
import { encode } from "../ledger/toon-encode";

const commit = (sha: string, subject = `subj-${sha}`): GitLogEntry => ({ sha, subject });
const row = (id: string, state: string, title = `title-${id}`): LedgerRow => ({ id, title, state });
const fb = (id: string, summary = `fb-${id}`): FeedbackRow => ({ id, summary });

describe("director-brief brief()", () => {
  test("all-empty inputs → all buckets [], all hints absent", () => {
    const b = brief([], [], []);
    expect(b.done).toEqual([]);
    expect(b.current).toEqual([]);
    expect(b.next).toEqual([]);
    expect(b.hints).toEqual({});
  });

  // ---- done ----
  test("done = git log entries, newest-first as given, mapped to done items", () => {
    const b = brief([commit("aaa"), commit("bbb")], [], []);
    expect(b.done).toEqual([
      { kind: "done", ref: "aaa", label: "subj-aaa" },
      { kind: "done", ref: "bbb", label: "subj-bbb" },
    ]);
    expect(b.hints.done).toBeUndefined();
  });

  // ---- current ----
  for (const s of ["claimed", "wip", "review"]) {
    test(`current includes ledger state "${s}"`, () => {
      const b = brief([], [row("i1", s)], []);
      expect(b.current).toEqual([{ kind: "current", ref: "i1", label: "title-i1" }]);
    });
  }

  test("current preserves input order", () => {
    const b = brief([], [row("i1", "wip"), row("i2", "claimed"), row("i3", "review")], []);
    expect(b.current.map((x: BriefItem) => x.ref)).toEqual(["i1", "i2", "i3"]);
  });

  // ---- next ----
  for (const s of ["ready", "blocked"]) {
    test(`next includes ledger state "${s}"`, () => {
      const b = brief([], [row("i1", s)], []);
      expect(b.next).toEqual([{ kind: "next", ref: "i1", label: "title-i1" }]);
    });
  }

  test("next = ledger-next items BEFORE feedback items", () => {
    const b = brief([], [row("i1", "ready"), row("i2", "blocked")], [fb("f1"), fb("f2")]);
    expect(b.next).toEqual([
      { kind: "next", ref: "i1", label: "title-i1" },
      { kind: "next", ref: "i2", label: "title-i2" },
      { kind: "next", ref: "f1", label: "fb-f1" },
      { kind: "next", ref: "f2", label: "fb-f2" },
    ]);
  });

  test("feedback alone → all in next", () => {
    const b = brief([], [], [fb("f1"), fb("f2")]);
    expect(b.next.map((x: BriefItem) => x.ref)).toEqual(["f1", "f2"]);
  });

  // ---- excluded states ----
  for (const s of ["merged", "cancelled", "failed", "garbage", ""]) {
    test(`state "${s}" appears in NEITHER current nor next`, () => {
      const b = brief([], [row("i1", s)], []);
      expect(b.current).toEqual([]);
      expect(b.next).toEqual([]);
    });
  }

  test("merged ledger row excluded; only valid states bucketed", () => {
    const b = brief(
      [],
      [row("a", "merged"), row("b", "wip"), row("c", "ready"), row("d", "cancelled")],
      [],
    );
    expect(b.current.map((x: BriefItem) => x.ref)).toEqual(["b"]);
    expect(b.next.map((x: BriefItem) => x.ref)).toEqual(["c"]);
  });

  // ---- cap + size hints ----
  test("done truncated at default cap 20 → hint 'showing 20 of 25'", () => {
    const log = Array.from({ length: 25 }, (_, i) => commit(`c${i}`));
    const b = brief(log, [], []);
    expect(b.done).toHaveLength(20);
    expect(b.done[0]!.ref).toBe("c0");
    expect(b.done[19]!.ref).toBe("c19");
    expect(b.hints.done).toBe("showing 20 of 25");
  });

  test("no hint when bucket exactly at cap (not truncated)", () => {
    const log = Array.from({ length: 20 }, (_, i) => commit(`c${i}`));
    const b = brief(log, [], []);
    expect(b.done).toHaveLength(20);
    expect(b.hints.done).toBeUndefined();
  });

  test("explicit cap truncates current; hint reflects total", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`i${i}`, "wip"));
    const b = brief([], rows, [], { cap: 2 });
    expect(b.current.map((x: BriefItem) => x.ref)).toEqual(["i0", "i1"]);
    expect(b.hints.current).toBe("showing 2 of 5");
  });

  test("combined-next cap truncates across ledger+feedback boundary", () => {
    // cap 3, 2 ready rows + 4 feedback → 2 ledger + 1 feedback, hint 'showing 3 of 6'
    const b = brief(
      [],
      [row("i1", "ready"), row("i2", "ready")],
      [fb("f1"), fb("f2"), fb("f3"), fb("f4")],
      { cap: 3 },
    );
    expect(b.next).toEqual([
      { kind: "next", ref: "i1", label: "title-i1" },
      { kind: "next", ref: "i2", label: "title-i2" },
      { kind: "next", ref: "f1", label: "fb-f1" },
    ]);
    expect(b.hints.next).toBe("showing 3 of 6");
  });

  test("cap 0 → empty buckets, hints 'showing 0 of N' when N>0", () => {
    const b = brief([commit("a")], [row("i1", "wip")], [fb("f1")], { cap: 0 });
    expect(b.done).toEqual([]);
    expect(b.current).toEqual([]);
    expect(b.next).toEqual([]);
    expect(b.hints.done).toBe("showing 0 of 1");
    expect(b.hints.current).toBe("showing 0 of 1");
    expect(b.hints.next).toBe("showing 0 of 1");
  });

  test("cap 0 with empty source → no hint for that bucket", () => {
    const b = brief([], [row("i1", "wip")], [], { cap: 0 });
    expect(b.hints.done).toBeUndefined();
    expect(b.hints.current).toBe("showing 0 of 1");
    expect(b.hints.next).toBeUndefined();
  });

  test("negative cap → default 20", () => {
    const log = Array.from({ length: 25 }, (_, i) => commit(`c${i}`));
    const b = brief(log, [], [], { cap: -5 });
    expect(b.done).toHaveLength(20);
    expect(b.hints.done).toBe("showing 20 of 25");
  });

  test("undefined cap (opts present, no cap) → default 20", () => {
    const log = Array.from({ length: 25 }, (_, i) => commit(`c${i}`));
    const b = brief(log, [], [], {});
    expect(b.done).toHaveLength(20);
  });

  test("cap larger than source → no truncation, no hint", () => {
    const b = brief([commit("a")], [row("i1", "wip")], [fb("f1")], { cap: 99 });
    expect(b.done).toHaveLength(1);
    expect(b.current).toHaveLength(1);
    expect(b.next).toHaveLength(1);
    expect(b.hints).toEqual({});
  });

  // ---- render smoke (Part B uses toon-encode the same way) ----
  test("brief() result renders TOON-shaped and non-empty via encode()", () => {
    const b = brief([commit("aaa")], [row("i1", "wip")], [fb("f1")]);
    const rendered = encode(b.current as unknown as Record<string, unknown>[]);
    expect(rendered).toContain("[1]{");
    expect(rendered.length).toBeGreaterThan(0);
  });
});
