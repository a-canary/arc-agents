#!/usr/bin/env bun
// Screenshot + self-critique for arc-webui.
// Runs headless chromium against ARC_SURFACE_URL, captures full-page screenshot,
// fails on any console.error / page-error, and exits 0/1 with JSON diagnostics.

import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────
const SURFACE_URL =
  process.env.ARC_SURFACE_URL ?? "http://100.91.151.13:8080";
const REPO =
  process.env.ARC_SURFACE_REPO ?? "arc-agents";
const ARTIFACT_DIR =
  process.env.ARC_SURFACE_ARTIFACT_DIR ?? join(
    process.env.HOME ?? "/root",
    "vault",
    "artifacts",
    "playwright",
  );

// ── Types ────────────────────────────────────────────────────────────────────
interface Result {
  status: "PASS" | "FAIL";
  url: string;
  screenshot: string | null;
  console_errors: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function artifactPath(commit: string): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  return join(ARTIFACT_DIR, `${REPO}-${commit}.png`);
}

async function waitForSurface(page: Page): Promise<void> {
  // quest-pane appears on the /quest route after redirect.
  await page.waitForSelector(
    ".quest-pane, .afk-bar, [data-testid=quest-pane]",
    { state: "visible", timeout: 15_000 },
  );
}

function formatResult(result: Result): void {
  // Print exactly one JSON line to stdout so callers can pipe/parse.
  console.log(JSON.stringify(result));
}

// ── Main ─────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

const consoleErrors: string[] = [];

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(err.message));

const commit = process.env.GIT_COMMIT ?? await new Response(
  "https://api.github.com/repos/a-canary/arc-agents/commits/main",
)
  .json()
  .then((j: { sha: string }) => j.sha.slice(0, 8))
  .catch(() => "unknown");

let status: Result["status"] = "PASS";
let screenshotPath: string | null = null;

try {
  await page.goto(SURFACE_URL, { waitUntil: "networkidle", timeout: 20_000 });
  await waitForSurface(page);

  screenshotPath = artifactPath(commit);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  if (consoleErrors.length > 0) {
    status = "FAIL";
  }
} catch (err) {
  status = "FAIL";
  consoleErrors.push(`[navigation] ${(err as Error).message}`);
} finally {
  await browser.close();
}

const result: Result = {
  status,
  url: SURFACE_URL,
  screenshot: screenshotPath,
  console_errors: consoleErrors,
};

formatResult(result);

process.exit(status === "PASS" ? 0 : 1);