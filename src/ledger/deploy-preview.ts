// Deploy-preview probe — pure logic for ADR 0007.
//
// dev-quest's FOCUS pane wants to show a "Preview ready" badge for issues
// where the PR has a live deploy. Rather than spawn a daemon, we run a
// cron-scheduled skill that:
//
//   1. Lists candidate issues — `pr_url` non-null, no prior `deploy_preview`
//      event yet (so we don't spam).
//   2. Probes each PR for a preview URL (Vercel/Netlify deploy URL parsed
//      from the GitHub PR's body or comments).
//   3. For each PR that resolves, emits a `deploy_preview` event on the
//      issue with the preview URL in the payload.
//
// This module is pure: it works over typed inputs/outputs and accepts an
// injected `fetchFn` so tests don't hit the network. The bin/CLI shell
// does the actual ledger I/O and shell-out.

export type CandidateRow = {
  id: string;
  pr_url: string;
};

export type PreviewProbeResult = {
  id: string;
  pr_url: string;
  preview_url: string | null;
  provider: string | null;
  probed_at: number;
  skip_reason?: string;
};

export type FetchResponseLite = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string },
) => Promise<FetchResponseLite>;

/**
 * Parse a GitHub PR URL into { owner, repo, number }.
 * Returns null if the URL is not a recognizable github PR.
 */
export function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  try {
    const u = new URL(prUrl);
    if (!u.hostname.endsWith("github.com")) return null;
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!m) return null;
    const n = Number.parseInt(m[3]!, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { owner: m[1]!, repo: m[2]!, number: n };
  } catch {
    return null;
  }
}

const PROVIDER_HOST_PATTERNS: { pattern: RegExp; provider: string }[] = [
  { pattern: /\.vercel\.app$/i, provider: "vercel" },
  { pattern: /\.netlify\.app$/i, provider: "netlify" },
  { pattern: /\.netlify\.com$/i, provider: "netlify" },
  { pattern: /\.pages\.dev$/i, provider: "cloudflare-pages" },
  { pattern: /\.github\.io$/i, provider: "github-pages" },
];

export function classifyPreviewHost(previewUrl: string): string | null {
  try {
    const u = new URL(previewUrl);
    for (const { pattern, provider } of PROVIDER_HOST_PATTERNS) {
      if (pattern.test(u.hostname)) return provider;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Scan PR body or comment markdown for a deploy preview URL. The signal we
 * trust is a recognizable provider hostname; we don't try to be clever
 * about arbitrary "deployed to <url>" prose.
 */
export function extractPreviewUrl(markdown: string): { url: string; provider: string } | null {
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    let url = m[0]!.replace(/[.,;:!?]+$/, "");
    const provider = classifyPreviewHost(url);
    if (provider) return { url, provider };
  }
  return null;
}

/**
 * Probe one PR for a deploy preview.
 *
 * Order of evidence checked:
 *   1. GET /repos/{owner}/{repo}/pulls/{number}     — PR body
 *   2. GET /repos/{owner}/{repo}/issues/{n}/comments — bot comment URLs
 *   3. GET /repos/{owner}/{repo}/pulls/{n}/comments  — review comment URLs
 *
 * First match wins. Each fetch is only made when no match was found yet.
 */
export async function probePreview(
  pr_url: string,
  opts: {
    fetchFn: FetchFn;
    nowFn?: () => number;
    token?: string | null;
  },
): Promise<Omit<PreviewProbeResult, "id">> {
  const now = opts.nowFn ?? (() => Math.floor(Date.now() / 1000));
  const parsed = parsePrUrl(pr_url);
  if (!parsed) {
    return {
      pr_url,
      preview_url: null,
      provider: null,
      probed_at: now(),
      skip_reason: "unrecognized PR url",
    };
  }
  const headers: Record<string, string> = {
    "User-Agent": "arc-agents-deploy-preview/1",
    Accept: "application/vnd.github+json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;

  const sources = [
    `${base}/pulls/${parsed.number}`,
    `${base}/issues/${parsed.number}/comments`,
    `${base}/pulls/${parsed.number}/comments`,
  ];

  for (const url of sources) {
    let res: FetchResponseLite;
    try {
      res = await opts.fetchFn(url, { headers });
    } catch (e: unknown) {
      return {
        pr_url,
        preview_url: null,
        provider: null,
        probed_at: now(),
        skip_reason: `fetch error: ${(e as Error).message ?? String(e)}`,
      };
    }
    if (!res.ok) {
      if (res.status === 404) {
        return {
          pr_url,
          preview_url: null,
          provider: null,
          probed_at: now(),
          skip_reason: `github 404 for ${url}`,
        };
      }
      if (res.status === 403 || res.status === 401) {
        return {
          pr_url,
          preview_url: null,
          provider: null,
          probed_at: now(),
          skip_reason: `github ${res.status} for ${url}`,
        };
      }
      continue;
    }
    const body = await res.json();
    const bodies: string[] = Array.isArray(body)
      ? body.map((b: { body?: string }) => b.body ?? "")
      : [(body as { body?: string }).body ?? ""];
    for (const md of bodies) {
      const hit = extractPreviewUrl(md);
      if (hit) {
        return {
          pr_url,
          preview_url: hit.url,
          provider: hit.provider,
          probed_at: now(),
        };
      }
    }
  }

  return {
    pr_url,
    preview_url: null,
    provider: null,
    probed_at: now(),
    skip_reason: "no preview URL found in PR body or comments",
  };
}

export async function probeBatch(
  candidates: CandidateRow[],
  opts: { fetchFn: FetchFn; nowFn?: () => number; token?: string | null },
): Promise<PreviewProbeResult[]> {
  const out: PreviewProbeResult[] = [];
  for (const c of candidates) {
    const r = await probePreview(c.pr_url, opts);
    out.push({ id: c.id, ...r });
  }
  return out;
}

export function formatEventPayload(r: PreviewProbeResult): string {
  if (!r.preview_url) return `skip: ${r.skip_reason ?? "no preview"}`;
  return `provider: ${r.provider}\nurl: ${r.preview_url}`;
}
