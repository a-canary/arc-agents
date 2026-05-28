// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "bun:test";
import { computeOpusBurn } from "./opus-burn-check";

function makeExport(opusTokens: number, otherTokens: number, opusCost = 10, otherCost = 5) {
  return {
    schema: "codeburn.export.v2",
    periods: [
      {
        label: "Today",
        models: [
          {
            Period: "Today",
            Model: "Opus 4.7",
            "Cost (USD)": opusCost,
            "Share (%)": 80,
            "API Calls": 10,
            "Input Tokens": Math.floor(opusTokens * 0.3),
            "Output Tokens": Math.floor(opusTokens * 0.2),
            "Cache Read Tokens": Math.floor(opusTokens * 0.4),
            "Cache Write Tokens": Math.floor(opusTokens * 0.1),
          },
          {
            Period: "Today",
            Model: "claude-3-5-sonnet",
            "Cost (USD)": otherCost,
            "Share (%)": 20,
            "API Calls": 5,
            "Input Tokens": Math.floor(otherTokens * 0.5),
            "Output Tokens": Math.floor(otherTokens * 0.5),
            "Cache Read Tokens": 0,
            "Cache Write Tokens": 0,
          },
        ],
      },
      { label: "7 Days", models: [] },
      { label: "30 Days", models: [] },
    ],
  };
}

test("computeOpusBurn: share computed correctly when opus > 50%", () => {
  // opus: 8000 tokens, other: 2000 tokens → 80% share
  const result = computeOpusBurn(makeExport(8000, 2000));
  expect(result.opusShare).toBeCloseTo(0.8, 2);
  expect(result.warn).toBe(true);
});

test("computeOpusBurn: warn=false when opus < 50%", () => {
  // opus: 2000 tokens, other: 8000 tokens → 20% share
  const result = computeOpusBurn(makeExport(2000, 8000));
  expect(result.opusShare).toBeCloseTo(0.2, 2);
  expect(result.warn).toBe(false);
});

test("computeOpusBurn: warn=false exactly at 50% boundary", () => {
  // opus: 5000 tokens, other: 5000 tokens → 50% share (not > 0.5, so no warn)
  const result = computeOpusBurn(makeExport(5000, 5000));
  expect(result.opusShare).toBeCloseTo(0.5, 2);
  expect(result.warn).toBe(false);
});

test("computeOpusBurn: graceful when no Today period", () => {
  const noToday = {
    schema: "codeburn.export.v2",
    periods: [
      { label: "7 Days", models: [] },
      { label: "30 Days", models: [] },
    ],
  };
  const result = computeOpusBurn(noToday);
  expect(result.warn).toBe(false);
  expect(result.opusShare).toBe(0);
});

test("computeOpusBurn: graceful when models array is empty", () => {
  const emptyModels = {
    schema: "codeburn.export.v2",
    periods: [{ label: "Today", models: [] }],
  };
  const result = computeOpusBurn(emptyModels);
  expect(result.warn).toBe(false);
  expect(result.opusShare).toBe(0);
});

test("computeOpusBurn: graceful when input is null/undefined", () => {
  expect(computeOpusBurn(null).warn).toBe(false);
  expect(computeOpusBurn(undefined).warn).toBe(false);
  expect(computeOpusBurn({}).warn).toBe(false);
});

test("computeOpusBurn: totalCostUsd sums all model costs", () => {
  const result = computeOpusBurn(makeExport(8000, 2000, 10, 5));
  expect(result.totalCostUsd).toBeCloseTo(15, 2);
});

test("computeOpusBurn: case-insensitive opus model matching", () => {
  const mixedCase = {
    periods: [
      {
        label: "Today",
        models: [
          {
            Period: "Today",
            Model: "CLAUDE-OPUS-3",
            "Cost (USD)": 9,
            "Share (%)": 90,
            "API Calls": 5,
            "Input Tokens": 9000,
            "Output Tokens": 0,
            "Cache Read Tokens": 0,
            "Cache Write Tokens": 0,
          },
          {
            Period: "Today",
            Model: "claude-haiku",
            "Cost (USD)": 1,
            "Share (%)": 10,
            "API Calls": 2,
            "Input Tokens": 1000,
            "Output Tokens": 0,
            "Cache Read Tokens": 0,
            "Cache Write Tokens": 0,
          },
        ],
      },
    ],
  };
  const result = computeOpusBurn(mixedCase);
  expect(result.opusShare).toBeCloseTo(0.9, 2);
  expect(result.warn).toBe(true);
});
