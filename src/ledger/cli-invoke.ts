// cli-invoke — spawn the ledger CLI as a subprocess and parse its JSON output.
//
// Two helpers, both used by `bin/*` scripts that need to shell out to the
// ledger CLI rather than importing it as a library:
//
//   dbFlag()           — returns ["--db", <path>] if ARC_LEDGER_DB is set,
//                        else []. Append this to any ledger CLI argv so a
//                        test/dev invocation targets the same DB as the
//                        parent process.
//   runLedgerJson<T>() — spawns `bun <ledger.ts> <verb> ...args --db ...`,
//                        parses stdout as JSON, and returns it. On a non-zero
//                        exit (or malformed JSON) returns the supplied
//                        fallback. Lenient by design — call sites used to
//                        hand-roll `if (r.status !== 0) return []` try/catch
//                        blocks, and the new helper is the explicit shape
//                        of that pattern.
//
// Path resolution uses the bun binary that started this process
// (`process.execPath`), NOT a PATH-resolved `bun` — systemd runs the factory
// daemon with a PATH that excludes ~/.bun/bin, so `spawnSync("bun", ...)`
// silently ENOENTs. Regression test: `bin/factory.test.ts →
// "auditMergeableWorktrees works when PATH does not contain bun"`.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// cli-invoke.ts lives at <repo>/src/ledger/cli-invoke.ts. Three dirname()
// calls walk back up to the repo root, then `bin/ledger.ts` is appended.
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const LEDGER_BIN = join(REPO, "bin", "ledger.ts");

/** CLI flag pair for the (optional) `ARC_LEDGER_DB` env override. */
export function dbFlag(): string[] {
  return process.env.ARC_LEDGER_DB ? ["--db", process.env.ARC_LEDGER_DB] : [];
}

/** Spawn the ledger CLI for `<verb> <args>...`, return parsed JSON stdout.
 *  On non-zero exit or parse failure, return `fallback`. */
export function runLedgerJson<T>(verb: string, args: readonly string[], fallback: T): T {
  const r = spawnSync(
    process.execPath,
    [LEDGER_BIN, verb, ...args, ...dbFlag()],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return fallback;
  try {
    return JSON.parse(r.stdout ?? "") as T;
  } catch {
    return fallback;
  }
}
