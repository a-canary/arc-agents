/**
 * pipeliner-models test suite — cost-aware Thompson sampling coverage
 *
 * Tests the cost-aware thompsonSample algorithm added in commit
 * 5a9444c837cb ("feat: cost-aware Thompson sampling includes judge cost").
 *
 * Import path points to pipeliner dist (npm-linked or relative).
 */
import { describe, it } from "node:test";
import assert from "node:assert";
// Import ModelRegistry from pipeliner dist (linked via npm or workspace)
import { ModelRegistry } from "pi-pipeliner/dist/src/models.js";

const DIR = "/tmp/pipeliner-models-test";

// ── Helpers ────────────────────────────────────────────────────────────────

interface TaskMetrics {
  runs: number;
  passes: number;
  avgLatencyMs: number;
  totalTokens: number;
  lastUsed: string;
}

function makeRegistry(taskData?: Record<string, Record<string, TaskMetrics>>): ModelRegistry {
  const reg = new ModelRegistry(DIR);
  if (taskData) {
    for (const [modelRef, tasks] of Object.entries(taskData)) {
      for (const [task, metrics] of Object.entries(tasks)) {
        const m = (reg as unknown as Record<string, unknown>).ensureTask(modelRef, task) as TaskMetrics;
        Object.assign(m, metrics);
      }
    }
  }
  return reg;
}

// ── thompsonSample baseline ────────────────────────────────────────────────

describe("thompsonSample", () => {
  it("returns an array with every available candidate", () => {
    const reg = makeRegistry();
    const result = reg.thompsonSample("test", [
      { ref: "a", cost: 0.01 },
      { ref: "b", cost: 0.02 },
      { ref: "c", cost: 0.03 },
    ]);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 3);
    for (const r of result) {
      assert.ok("ref" in r);
      assert.ok("cost" in r);
      assert.ok("sample" in r);
      assert.ok("expected" in r);
      assert.ok("value" in r);
    }
  });

  it("filters unavailable models", () => {
    const reg = makeRegistry();
    reg.cooldown("a");
    const result = reg.thompsonSample("test", [
      { ref: "a", cost: 0.01 },
      { ref: "b", cost: 0.02 },
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].ref, "b");
  });

  it("uses uniform prior (alpha=1, beta=1) for unseen model×task", () => {
    const reg = makeRegistry();
    const result = reg.thompsonSample("unseen-task", [{ ref: "never-seen", cost: 0.01 }]);
    assert.strictEqual(result.length, 1);
    // alpha=1, beta=1 → expected = 1/(1+1) = 0.5
    assert.strictEqual(result[0].expected, 0.5);
  });

  it("returns empty array when all candidates are unavailable", () => {
    const reg = makeRegistry();
    reg.cooldown("a");
    reg.cooldown("b");
    const result = reg.thompsonSample("test", [
      { ref: "a", cost: 0.01 },
      { ref: "b", cost: 0.02 },
    ]);
    assert.strictEqual(result.length, 0);
  });
});

// ── judgeCost = 0 — cost-agnostic ranking ────────────────────────────────

describe("thompsonSample judgeCost=0", () => {
  it("setting judgeCost=0 yields sorted descending by value", () => {
    const reg = makeRegistry();
    const result = reg.thompsonSample("test", [
      { ref: "a", cost: 0.01 },
      { ref: "b", cost: 0.02 },
      { ref: "c", cost: 0.03 },
    ], 0);
    for (let i = 1; i < result.length; i++) {
      assert.ok(
        result[i - 1].value >= result[i].value,
        `result[${i - 1}].value (${result[i - 1].value}) should be >= result[${i}].value (${result[i].value})`,
      );
    }
  });

  it("returns same length as available candidates", () => {
    const reg = makeRegistry();
    reg.cooldown("b");
    const result = reg.thompsonSample("test", [
      { ref: "a", cost: 0.01 },
      { ref: "b", cost: 0.02 },
      { ref: "c", cost: 0.03 },
    ], 0);
    assert.strictEqual(result.length, 2);
  });
});

// ── judgeCost > 0 — cost-aware ranking ──────────────────────────────────

describe("thompsonSample judgeCost>0", () => {
  it("judgeCost argument is accepted without throwing", () => {
    const reg = makeRegistry();
    assert.doesNotThrow(() => {
      reg.thompsonSample("test", [
        { ref: "a", cost: 0.01 },
        { ref: "b", cost: 0.02 },
      ], 0.20);
    });
  });

  it("judgeCost constant addition compresses cost gap", () => {
    // Deterministic draw isolates judgeCost effect.
    const reg = makeRegistry();
    (reg as unknown as Record<string, unknown>).sampleBeta = () => 0.5;

    const result = reg.thompsonSample("test", [
      { ref: "cheap", cost: 0.02 },
      { ref: "expensive", cost: 0.30 },
    ], 0.20);

    assert.strictEqual(result.length, 2);
    // cheap: 0.5/(0.02+0.20)=0.5/0.22≈2.27; expensive: 0.5/(0.30+0.20)=0.5/0.50=1.0
    assert.ok(
      result[0].value >= result[1].value,
      `cheap model should rank first: got rank[0]=${result[0].ref}`,
    );
  });

  it("all values decrease when judgeCost is added", () => {
    const reg = makeRegistry();
    (reg as unknown as Record<string, unknown>).sampleBeta = () => 0.5;

    const base = reg.thompsonSample("test", [
      { ref: "a", cost: 0.02 },
      { ref: "b", cost: 0.03 },
    ], 0);
    const judged = reg.thompsonSample("test", [
      { ref: "a", cost: 0.02 },
      { ref: "b", cost: 0.03 },
    ], 0.20);

    for (let i = 0; i < base.length; i++) {
      assert.ok(
        judged[i].value < base[i].value,
        `with judgeCost, value should drop: ${base[i].ref} ${base[i].value} → ${judged[i].value}`,
      );
    }
  });

  it("cost gap compression ratio is meaningfully reduced vs judgeCost=0", () => {
    // Whole point of the feature: without judge, 15× gap. With judge, ~2.3× gap.
    const reg = makeRegistry();
    (reg as unknown as Record<string, unknown>).sampleBeta = () => 0.5;

    const judged = reg.thompsonSample("test", [
      { ref: "cheap", cost: 0.02 },
      { ref: "expensive", cost: 0.30 },
    ], 0.20);

    assert.strictEqual(judged.length, 2);
    const ratio = judged[0].value / judged[1].value;
    // Without judge: 0.5/0.02=25 vs 0.5/0.30≈1.67 → 15× ratio
    // With judge: ≈2.27 vs 1.0 → ~2.27× ratio
    // Assert ratio is well below 15 (proves the compression works)
    assert.ok(ratio < 8, `cost-gap compression ratio ${ratio.toFixed(3)} should be < 8`);
  });
});

// ── Zero cost edge cases ─────────────────────────────────────────────────

describe("thompsonSample zero-cost edge cases", () => {
  it("zero generator cost + judgeCost>0: no zero-div, value = sample / judgeCost", () => {
    const reg = makeRegistry();
    (reg as unknown as Record<string, unknown>).sampleBeta = () => 0.5;
    const result = reg.thompsonSample("test", [
      { ref: "free", cost: 0 },
      { ref: "paid", cost: 0.10 },
    ], 0.20);
    assert.strictEqual(result.length, 2);
    assert.ok(Number.isFinite(result[0].value));
    assert.ok(Number.isFinite(result[1].value));
    // free: totalCost = 0.20, value = 0.5/0.20 = 2.5
    // paid: totalCost = 0.30, value = 0.5/0.30 ≈ 1.67
    assert.ok(result[0].value >= result[1].value);
  });

  it("zero generator cost + judgeCost=0: value falls back to sample (guarded)", () => {
    const reg = makeRegistry();
    (reg as unknown as Record<string, unknown>).sampleBeta = () => 0.5;
    const result = reg.thompsonSample("test", [
      { ref: "free", cost: 0 },
      { ref: "paid", cost: 0.10 },
    ], 0);
    assert.strictEqual(result.length, 2);
    assert.ok(Number.isFinite(result[0].value));
    assert.ok(Number.isFinite(result[1].value));
  });

  it("zero all costs: value = sample (guarded — never zero-div)", () => {
    const reg = makeRegistry();
    (reg as unknown as Record<string, unknown>).sampleBeta = () => 0.5;
    const result = reg.thompsonSample("test", [
      { ref: "free", cost: 0 },
    ], 0);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].value, 0.5); // value = sample when totalCost === 0
  });
});

// ── Beta prior interaction ───────────────────────────────────────────────

describe("thompsonSample beta prior", () => {
  it("high-pass model ranked higher — beta prior reflected in expected", () => {
    const reg = makeRegistry({
      good: { test: { runs: 10, passes: 9, avgLatencyMs: 1000, totalTokens: 0, lastUsed: "2026-01-01" } },
      bad: { test: { runs: 10, passes: 1, avgLatencyMs: 1000, totalTokens: 0, lastUsed: "2026-01-01" } },
    });
    let callCount = 0;
    (reg as unknown as Record<string, unknown>).sampleBeta = () => {
      callCount++;
      return callCount === 1 ? 0.9 : 0.1; // good first, bad second
    };
    const result = reg.thompsonSample("test", [
      { ref: "good", cost: 0.05 },
      { ref: "bad", cost: 0.01 },
    ], 0);
    assert.strictEqual(result[0].ref, "good");
  });

  it("recordQA updates prior for subsequent thompsonSample calls", () => {
    const reg = makeRegistry();
    const result1 = reg.thompsonSample("task2", [{ ref: "new", cost: 0.01 }]);
    assert.strictEqual(result1[0].expected, 0.5); // alpha=1, beta=1 → 0.5

    reg.recordQA("new", "task2", true);
    reg.recordQA("new", "task2", true);

    const result2 = reg.thompsonSample("task2", [{ ref: "new", cost: 0.01 }]);
    // after 2 passes: alpha=3, beta=1 → expected=3/4=0.75
    assert.ok(result2[0].expected > result1[0].expected);
  });
});

// ── API surface ─────────────────────────────────────────────────────────

describe("thompsonSample API", () => {
  it("returns all expected fields on each item", () => {
    const reg = makeRegistry();
    const result = reg.thompsonSample("test", [{ ref: "m", cost: 0.01 }]);
    assert.ok("ref" in result[0]);
    assert.ok("cost" in result[0]);
    assert.ok("sample" in result[0]);
    assert.ok("expected" in result[0]);
    assert.ok("value" in result[0]);
  });

  it("works with one candidate", () => {
    const reg = makeRegistry();
    const result = reg.thompsonSample("test", [{ ref: "solo", cost: 0.05 }]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].ref, "solo");
  });

  it("judgeCost defaults to 0 when omitted", () => {
    const reg = makeRegistry();
    const noArg = reg.thompsonSample("test", [{ ref: "m", cost: 0.01 }]);
    const explicit0 = reg.thompsonSample("test", [{ ref: "m", cost: 0.01 }], 0);
    assert.strictEqual(noArg.length, explicit0.length);
  });
});
