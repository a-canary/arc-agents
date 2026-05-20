import { test, expect } from "bun:test";
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function fresh(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-backfill-"));
  const db = join(dir, "t.db");
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedPhantom(db: string, ids: { id: string; state: string }[]) {
  const sqliteDb = new Database(db);
  const now = Math.floor(Date.now() / 1000);
  for (const { id, state } of ids) {
    sqliteDb.run(
      `INSERT INTO issues (id, project, body_md, kind, type, title, state, claimed_by, claimed_at, created_at, updated_at)
       VALUES (?, 'p', '', 'task', 'mvp', 't', ?, 'w1', ?, ?, ?)`,
      [id, state, now, now, now],
    );
  }
  sqliteDb.close();
}

function rowsWithClaim(db: string): { id: string; state: string; claimed_by: string | null; claimed_at: number | null }[] {
  const sqliteDb = new Database(db);
  const r = sqliteDb.query<
    { id: string; state: string; claimed_by: string | null; claimed_at: number | null },
    []
  >(`SELECT id, state, claimed_by, claimed_at FROM issues ORDER BY id`).all();
  sqliteDb.close();
  return r;
}

test("backfill-phantom-claims: dry-run reports targets but writes nothing", async () => {
  const { db, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    seedPhantom(db, [
      { id: "p1", state: "merged" },
      { id: "p2", state: "failed" },
      { id: "ok", state: "wip" },
    ]);

    const r = await $`bun ${cli} backfill-phantom-claims --db ${db} --json`.quiet();
    const out = JSON.parse(r.stdout.toString());
    expect(out.found).toBe(2);
    expect(out.applied).toBe(false);
    expect(out.updated).toBe(0);

    const after = rowsWithClaim(db);
    for (const r of after) {
      expect(r.claimed_by).toBe("w1");
      expect(r.claimed_at).not.toBeNull();
    }
  } finally {
    cleanup();
  }
});

test("backfill-phantom-claims: --apply nulls claimed_by/claimed_at on terminal/non-claim rows only", async () => {
  const { db, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    seedPhantom(db, [
      { id: "merged-row", state: "merged" },
      { id: "failed-row", state: "failed" },
      { id: "cancelled-row", state: "cancelled" },
      { id: "blocked-row", state: "blocked" },
      { id: "wip-row", state: "wip" },
      { id: "claimed-row", state: "claimed" },
    ]);

    const r = await $`bun ${cli} backfill-phantom-claims --db ${db} --apply --json`.quiet();
    const out = JSON.parse(r.stdout.toString());
    expect(out.found).toBe(4);
    expect(out.applied).toBe(true);
    expect(out.updated).toBe(4);

    const after = Object.fromEntries(rowsWithClaim(db).map((r) => [r.id, r]));
    for (const id of ["merged-row", "failed-row", "cancelled-row", "blocked-row"]) {
      expect(after[id]!.claimed_by).toBeNull();
      expect(after[id]!.claimed_at).toBeNull();
    }
    for (const id of ["wip-row", "claimed-row"]) {
      expect(after[id]!.claimed_by).toBe("w1");
      expect(after[id]!.claimed_at).not.toBeNull();
    }
  } finally {
    cleanup();
  }
});

test("backfill-phantom-claims: empty ledger reports zero", async () => {
  const { db, cleanup } = fresh();
  try {
    await $`bun ${cli} init --db ${db}`.quiet();
    const r = await $`bun ${cli} backfill-phantom-claims --db ${db} --json`.quiet();
    const out = JSON.parse(r.stdout.toString());
    expect(out.found).toBe(0);
    expect(out.updated).toBe(0);
  } finally {
    cleanup();
  }
});
