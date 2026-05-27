#!/usr/bin/env bun
// Purge hermes-gateway retired project references from encounters.json
// hermes-gateway retired 2026-05-12

import { readFileSync, writeFileSync } from "node:fs";

const ENC = "/home/aaron/vault/webui/techtree/encounters.json";
const BACKUP = ENC + ".bak";

const data = JSON.parse(readFileSync(ENC, "utf8"));
const originalCount = data.items.length;

const HERMES_RE = /hermes/i;

const hermesItems = data.items.filter((i) => {
  if (i.project && HERMES_RE.test(i.project)) return true;
  if (i.quest_id && HERMES_RE.test(i.quest_id)) return true;
  if (i.quest_title && HERMES_RE.test(i.quest_title)) return true;
  return false;
});

const remaining = data.items.filter((i) => {
  if (i.project && HERMES_RE.test(i.project)) return false;
  if (i.quest_id && HERMES_RE.test(i.quest_id)) return false;
  if (i.quest_title && HERMES_RE.test(i.quest_title)) return false;
  return true;
});

const hermesIds = hermesItems.map((i) => i.id);

// Backup
writeFileSync(BACKUP, JSON.stringify(data, null, 2));
console.log(`Backup: ${BACKUP}`);

// Write cleaned
writeFileSync(ENC, JSON.stringify({ items: remaining }, null, 2));
console.log(`Removed: ${hermesIds.length} hermes entries`);
console.log(`Before: ${originalCount}, After: ${remaining.length}`);
console.log("IDs removed:", hermesIds.join(", "));

// Verify no hermes refs remain
const check = JSON.parse(readFileSync(ENC, "utf8"));
const residual = check.items.filter((i) =>
  HERMES_RE.test(i.project || "") ||
  HERMES_RE.test(i.quest_id || "") ||
  HERMES_RE.test(i.quest_title || "")
);
if (residual.length > 0) {
  console.error("FAIL: residual hermes refs:", residual.map((i) => i.id));
  process.exit(1);
}
console.log("PASS: Zero hermes references remaining in encounters.json");