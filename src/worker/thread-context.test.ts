// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../ledger/migrate";
import { loadThreadContext } from "./thread-context";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function insert(
  db: Database,
  row: {
    id: string;
    kind: string;
    type?: string;
    title: string;
    body_md?: string;
    thread_id?: string;
    source_module?: string;
    state?: string;
  },
) {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, thread_id, source_module)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      "test",
      row.title,
      row.body_md ?? "",
      row.type ?? "interactive",
      row.state ?? "merged",
      row.kind,
      row.thread_id ?? null,
      row.source_module ?? "arc-chat",
    ],
  );
}

describe("loadThreadContext", () => {
  it("returns empty string when no prior turns exist", () => {
    const db = freshDb();
    insert(db, { id: "i-cur", kind: "event", title: "current", thread_id: "t-empty" });
    expect(loadThreadContext(db, "t-empty", "i-cur")).toBe("");
  });

  it("renders prior event rows as [user] and reply rows as [you], oldest first", () => {
    const db = freshDb();
    insert(db, { id: "i-001", kind: "event", title: "first user msg", body_md: "first user msg", thread_id: "t-x" });
    insert(db, { id: "i-002", kind: "reply", title: "prior reply", body_md: "prior reply body", thread_id: "t-x" });
    insert(db, { id: "i-003", kind: "event", title: "second user msg", body_md: "second user msg", thread_id: "t-x" });

    const out = loadThreadContext(db, "t-x", "i-003");
    expect(out).toContain("Prior turns in this thread (oldest first):");
    expect(out).toContain("[user] first user msg");
    expect(out).toContain("[you] prior reply body");
    // current id excluded
    expect(out).not.toContain("second user msg");
    // ordering: user before you
    expect(out.indexOf("[user] first user msg")).toBeLessThan(out.indexOf("[you] prior reply body"));
  });

  it("falls back to title when body_md is empty", () => {
    const db = freshDb();
    insert(db, { id: "i-001", kind: "event", title: "title-only msg", body_md: "", thread_id: "t-t" });
    insert(db, { id: "i-002", kind: "event", title: "current", thread_id: "t-t" });
    const out = loadThreadContext(db, "t-t", "i-002");
    expect(out).toContain("[user] title-only msg");
  });

  it("filters out rows from other source_modules", () => {
    const db = freshDb();
    insert(db, { id: "i-001", kind: "event", title: "chat msg", body_md: "chat msg", thread_id: "t-f", source_module: "arc-chat" });
    insert(db, { id: "i-002", kind: "event", title: "other msg", body_md: "other msg", thread_id: "t-f", source_module: "something-else" });
    insert(db, { id: "i-003", kind: "event", title: "current", thread_id: "t-f" });
    const out = loadThreadContext(db, "t-f", "i-003");
    expect(out).toContain("chat msg");
    expect(out).not.toContain("other msg");
  });

  it("filters out rows of disallowed kinds (e.g. task, prefetch)", () => {
    const db = freshDb();
    insert(db, { id: "i-001", kind: "event", title: "kept event", body_md: "kept event", thread_id: "t-k" });
    insert(db, { id: "i-002", kind: "prefetch", title: "skipped prefetch", body_md: "skipped prefetch", thread_id: "t-k" });
    insert(db, { id: "i-003", kind: "event", title: "current", thread_id: "t-k" });
    const out = loadThreadContext(db, "t-k", "i-003");
    expect(out).toContain("kept event");
    expect(out).not.toContain("skipped prefetch");
  });

  it("replays arc-sprint handoff events as [handoff]", () => {
    const db = freshDb();
    insert(db, { id: "i-001", kind: "event", title: "sprint handoff", body_md: "what I tried: foo", thread_id: "t-sprint", source_module: "arc-sprint" });
    insert(db, { id: "i-002", kind: "event", title: "current sprint", thread_id: "t-sprint", source_module: "arc-sprint" });
    const out = loadThreadContext(db, "t-sprint", "i-002");
    expect(out).toContain("[handoff] what I tried: foo");
    expect(out).not.toContain("[user] what I tried");
  });

  it("disjoint union: chat + sprint events both appear with correct speakers", () => {
    const db = freshDb();
    insert(db, { id: "i-001", kind: "event", title: "chat msg", body_md: "chat message body", thread_id: "t-union", source_module: "arc-chat" });
    insert(db, { id: "i-002", kind: "event", title: "sprint handoff", body_md: "sprint handoff body", thread_id: "t-union", source_module: "arc-sprint" });
    insert(db, { id: "i-003", kind: "event", title: "current", thread_id: "t-union", source_module: "arc-chat" });
    const out = loadThreadContext(db, "t-union", "i-003");
    expect(out).toContain("[user] chat message body");
    expect(out).toContain("[handoff] sprint handoff body");
    // oldest first: chat (i-001) before sprint (i-002)
    expect(out.indexOf("[user] chat message body")).toBeLessThan(out.indexOf("[handoff] sprint handoff body"));
  });

  it("arc-sprint reply (kind=reply) is NOT replayed", () => {
    const db = freshDb();
    insert(db, { id: "i-001", kind: "reply", title: "sprint reply", body_md: "sprint reply body", thread_id: "t-sreply", source_module: "arc-sprint" });
    insert(db, { id: "i-002", kind: "event", title: "current", thread_id: "t-sreply", source_module: "arc-sprint" });
    const out = loadThreadContext(db, "t-sreply", "i-002");
    expect(out).not.toContain("sprint reply body");
  });
});
