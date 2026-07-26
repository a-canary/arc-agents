#!/usr/bin/env bun
// estate-secret-inventory.ts — scans every repo under a root (working tree +
// full git history) for leaked secrets, emitting a findings list of
// {repo, commit, fingerprint}. Read-only: no rotation, no history rewrite.
// ponytail: wraps gitleaks (already installed, already the estate's chosen
// scanner in secret-scan-gate.sh) instead of hand-rolling regex.
import { readdirSync, statSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = process.argv[2] ?? join(process.env.HOME ?? "", "repos");

function findRepos(dir: string): string[] {
  const repos: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, ".git"))) repos.push(p);
  }
  return repos.sort();
}

type Finding = {
  repo: string;
  commit: string;
  file: string;
  ruleId: string;
  fingerprint: string;
};

function scanRepo(repo: string): Finding[] {
  const configPath = join(repo, ".gitleaks.toml");
  const reportPath = join(tmpdir(), `gitleaks-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const args = [
    "detect",
    "--source", repo,
    "--report-format", "json",
    "--report-path", reportPath,
    "--no-banner",
    "--redact", // never surface raw secret values, matches secret-scan-gate.sh convention
    "--exit-code", "0", // don't fail the process; we aggregate findings ourselves
  ];
  if (existsSync(configPath)) args.push("--config", configPath);

  const res = spawnSync("gitleaks", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    console.error(`[estate-secret-inventory] ${repo}: gitleaks failed to run: ${res.error.message}`);
    return [];
  }
  if (!existsSync(reportPath)) return [];
  const out = readFileSync(reportPath, "utf8").trim();
  rmSync(reportPath, { force: true });
  if (!out) return [];
  let parsed: any[];
  try {
    parsed = JSON.parse(out);
  } catch {
    console.error(`[estate-secret-inventory] ${repo}: could not parse gitleaks output`);
    return [];
  }
  return parsed.map((f) => ({
    repo,
    commit: f.Commit ?? "",
    file: f.File ?? "",
    ruleId: f.RuleID ?? "",
    fingerprint: f.Fingerprint ?? "",
  }));
}

function main() {
  const repos = findRepos(root);
  const findings: Finding[] = [];
  for (const repo of repos) {
    findings.push(...scanRepo(repo));
  }
  console.log(JSON.stringify({ scanned: repos.length, root, findings }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
}

main();
