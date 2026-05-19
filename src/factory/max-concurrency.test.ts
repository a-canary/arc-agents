import { describe, it, expect } from "bun:test";
import { maySpawn } from "./max-concurrency";

describe("maySpawn", () => {
  it("returns false when live >= cap (cap=1, live=1)", () => {
    expect(maySpawn("developer", 1, { max_concurrency: 1 })).toBe(false);
  });

  it("returns true when live < cap", () => {
    expect(maySpawn("developer", 0, { max_concurrency: 1 })).toBe(true);
    expect(maySpawn("developer", 1, { max_concurrency: 2 })).toBe(true);
  });

  it("reads on-disk profile when no override provided", () => {
    // profiles/developer.json declares max_concurrency=1
    expect(maySpawn("developer", 0)).toBe(true);
    expect(maySpawn("developer", 1)).toBe(false);
    expect(maySpawn("director", 1)).toBe(false);
    expect(maySpawn("admin", 1)).toBe(false);
  });

  it("returns false when live exceeds cap", () => {
    expect(maySpawn("developer", 5, { max_concurrency: 2 })).toBe(false);
  });
});
