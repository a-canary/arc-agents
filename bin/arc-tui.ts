#!/usr/bin/env bun
// arc-tui — reference UX module. See ADR 0002.
//
// Subcommands:
//   heartbeat                              upsert ux_heartbeats row, exit
//   list                                   print open prompts for arc-tui as JSON lines
//   answer <prompt-id> <answer>            atomic first-reply-wins UPDATE
//
// Exit codes: 0 ok, 2 usage, 3 lost the race (prompt no longer open or not addressed)

import { open } from "../src/ledger/db";

const MODULE_NAME = "arc-tui";

const args = process.argv.slice(2);
const cmd = args[0];

function die(code: number, msg: string): never {
  process.stderr.write(`arc-tui: ${msg}\n`);
  process.exit(code);
}

switch (cmd) {
  case "heartbeat": {
    const db = open();
    db.run(
      `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES (?, strftime('%s','now'))
       ON CONFLICT(module_name) DO UPDATE SET last_beat=excluded.last_beat`,
      [MODULE_NAME],
    );
    break;
  }
  case "list": {
    const db = open();
    const rows = db
      .query<
        { id: string; kind: string; class: string; payload: string; recommended: string | null },
        [string]
      >(
        `SELECT p.id, p.kind, p.class, p.payload, p.recommended
         FROM hitl_prompts p
         JOIN hitl_deliveries d ON d.prompt_id = p.id
         WHERE p.state = 'open'
           AND d.module_name = ?
           AND d.state IN ('pending','delivered')
         ORDER BY p.id`,
      )
      .all(MODULE_NAME);
    for (const r of rows) {
      // One malformed payload must not poison the whole listing — surface it as
      // a raw string with a parse_error marker so the operator can still see+act
      // on healthy prompts.
      let payload: unknown;
      try {
        payload = JSON.parse(r.payload);
      } catch (e) {
        payload = { _parse_error: (e as Error).message, _raw: r.payload };
      }
      process.stdout.write(JSON.stringify({
        id: r.id,
        kind: r.kind,
        class: r.class,
        payload,
        recommended: r.recommended,
      }) + "\n");
    }
    break;
  }
  case "answer": {
    const id = args[1];
    const answer = args[2];
    if (!id || answer === undefined) die(2, "usage: answer <prompt-id> <answer>");
    const db = open();
    const now = Math.floor(Date.now() / 1000);
    // Atomic first-reply-wins, scoped to deliveries addressed to *this* module.
    // Without the delivery gate, any module could answer prompts targeted at
    // another module — the cascading retract trigger would then yank the
    // legitimate delivery. See arc-tui.test.ts "refuses to answer when not addressed".
    const r = db.run(
      `UPDATE hitl_prompts
       SET state='answered', answer=?, answered_by=?, answered_at=?
       WHERE id=? AND state='open'
         AND EXISTS (
           SELECT 1 FROM hitl_deliveries d
           WHERE d.prompt_id=hitl_prompts.id
             AND d.module_name=?
             AND d.state IN ('pending','delivered')
         )`,
      [answer, MODULE_NAME, now, id, MODULE_NAME],
    );
    if (r.changes === 0) die(3, `prompt ${id} no longer open or not addressed to ${MODULE_NAME}`);
    // Bump own delivery from pending → delivered so the retract trigger leaves it alone
    // (trigger only retracts deliveries whose module_name != answered_by).
    db.run(
      `UPDATE hitl_deliveries SET state='delivered', delivered_at=?
       WHERE prompt_id=? AND module_name=? AND state='pending'`,
      [now, id, MODULE_NAME],
    );
    break;
  }
  default:
    die(2, "usage: arc-tui <heartbeat|list|answer>");
}
