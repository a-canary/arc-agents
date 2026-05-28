// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { migrate } from "./migrate";

export function open(path?: string): Database {
  const p = path ?? process.env.ARC_LEDGER_DB ?? `${process.env.HOME}/vault/ledger.db`;
  const db = new Database(p);
  db.exec("PRAGMA journal_mode=WAL;");
  return db;
}

export function openWithMigrate(path?: string): Database {
  const db = open(path);
  migrate(db);
  return db;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function mintId(db: Database, title: string): string {
  const base = slugify(title);
  const exists = db.query<{ id: string }, [string]>("SELECT id FROM issues WHERE id=?");
  let id = base;
  while (exists.get(id)) id = `${base}-${shortId()}`;
  return id;
}
