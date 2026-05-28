#!/usr/bin/env bun
// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// arc-replay — capture-replay-diff harness for arc-agents (S-0003).
//
//   arc-replay capture <turn-id>                    freeze a worker turn into a fixture
//   arc-replay replay <capture> --config <path>     run candidate config against fixture
//   arc-replay diff <captureA> <captureB>           structured diff of two captures
//
// See skills/replay-shadow/SKILL.md for the contract. This binary is the
// arc-agents wiring; implementations are stubs pending fixture-format design.

const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}

function die(msg: string, code = 1): never {
  process.stderr.write(`arc-replay: ${msg}\n`);
  process.exit(code);
}

function usage(): never {
  process.stderr.write(
    "usage:\n" +
      "  arc-replay capture <turn-id>\n" +
      "  arc-replay replay <capture> --config <path>\n" +
      "  arc-replay diff <captureA> <captureB>\n",
  );
  process.exit(2);
}

switch (cmd) {
  case "capture": {
    const turnId = args[1];
    if (!turnId || turnId.startsWith("--")) die("usage: capture <turn-id>", 2);
    process.stdout.write(
      JSON.stringify({ verb: "capture", turn_id: turnId, status: "stub" }) + "\n",
    );
    break;
  }
  case "replay": {
    const capture = args[1];
    if (!capture || capture.startsWith("--")) die("usage: replay <capture> --config <path>", 2);
    const config = getFlag("config");
    if (!config) die("replay requires --config <path>", 2);
    process.stdout.write(
      JSON.stringify({ verb: "replay", capture, config, status: "stub" }) + "\n",
    );
    break;
  }
  case "diff": {
    const a = args[1];
    const b = args[2];
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) {
      die("usage: diff <captureA> <captureB>", 2);
    }
    process.stdout.write(
      JSON.stringify({ verb: "diff", a, b, status: "stub" }) + "\n",
    );
    break;
  }
  case "--help":
  case "-h":
  case undefined:
    usage();
  default:
    die(`unknown verb: ${cmd}`, 2);
}