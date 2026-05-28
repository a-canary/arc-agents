// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// S10: arc-webui tailscale-only binding smoke test.
// Boots Bun.serve on tailscale0, asserts only that iface accepts connections;
// non-tailnet IPs (LAN, loopback) refuse with ECONNREFUSED. Skips when
// tailscale0 is absent.

import { test, expect } from "bun:test";
import { networkInterfaces } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import { buildHandler, resolveIfaceAddr } from "./webui-server";

function nonInternalAddrs(): { iface: string; addr: string }[] {
  const out: { iface: string; addr: string }[] = [];
  const nets = networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    if (!list) continue;
    for (const a of list) {
      if (a.family === "IPv4" && !a.internal) out.push({ iface: name, addr: a.address });
    }
  }
  return out;
}

const hasTailscale = !!networkInterfaces()["tailscale0"];

test.skipIf(!hasTailscale)(
  "webui binds tailscale0 only — non-tailnet IPs refuse",
  async () => {
    const tsAddr = resolveIfaceAddr("tailscale0");
    const others = nonInternalAddrs().filter((x) => x.iface !== "tailscale0");
    // Need at least one non-tailscale iface to make the negative case meaningful.
    if (others.length === 0) return;

    const dir = mkdtempSync(join(tmpdir(), "webui-smoke-"));
    const db = openWithMigrate(join(dir, "t.db"));
    const server = Bun.serve({ hostname: tsAddr, port: 0, fetch: buildHandler(db) });
    try {
      const port = server.port;

      // Positive: tailscale0 address accepts.
      const ok = await fetch(`http://${tsAddr}:${port}/health`);
      expect(ok.status).toBe(200);

      // Negative: each non-tailscale address refuses.
      for (const { addr } of others) {
        let refused = false;
        try {
          await fetch(`http://${addr}:${port}/health`, {
            signal: AbortSignal.timeout(1500),
          });
        } catch {
          refused = true;
        }
        expect(refused).toBe(true);
      }

      // Negative: loopback refuses (server is not bound to 127.0.0.1).
      let loopbackRefused = false;
      try {
        await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        loopbackRefused = true;
      }
      expect(loopbackRefused).toBe(true);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("resolveIfaceAddr fails fast on missing iface (no 0.0.0.0 fallback)", () => {
  expect(() => resolveIfaceAddr("definitely-no-iface-s10")).toThrow(/not found/);
});
