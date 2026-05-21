import { test, expect } from "bun:test";
import {
  parsePrUrl, classifyPreviewHost, extractPreviewUrl,
  probePreview, probeBatch, formatEventPayload,
  type FetchFn, type FetchResponseLite,
} from "./deploy-preview";

const FIXED_NOW = 1_700_000_000;
const now = () => FIXED_NOW;

function mockRes(body: unknown, status = 200): FetchResponseLite {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    json: async () => typeof body === "string" ? JSON.parse(body) : body,
  };
}

function fetchScript(script: Record<string, FetchResponseLite>): FetchFn {
  return async (url: string) => {
    const r = script[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return r;
  };
}

test("parsePrUrl: happy path", () => {
  expect(parsePrUrl("https://github.com/foo/bar/pull/42"))
    .toEqual({ owner: "foo", repo: "bar", number: 42 });
  expect(parsePrUrl("https://github.com/foo/bar/pull/42/"))
    .toEqual({ owner: "foo", repo: "bar", number: 42 });
});

test("parsePrUrl: rejects non-github/non-pr urls", () => {
  expect(parsePrUrl("https://gitlab.com/foo/bar/pull/1")).toBeNull();
  expect(parsePrUrl("https://github.com/foo/bar/issues/1")).toBeNull();
  expect(parsePrUrl("https://github.com/foo/bar/pull/abc")).toBeNull();
  expect(parsePrUrl("not a url")).toBeNull();
  expect(parsePrUrl("https://github.com/foo/bar")).toBeNull();
});

test("classifyPreviewHost: known providers", () => {
  expect(classifyPreviewHost("https://foo-git-bar.vercel.app/")).toBe("vercel");
  expect(classifyPreviewHost("https://deploy-preview-1--site.netlify.app")).toBe("netlify");
  expect(classifyPreviewHost("https://site.pages.dev/path")).toBe("cloudflare-pages");
  expect(classifyPreviewHost("https://user.github.io/repo")).toBe("github-pages");
  expect(classifyPreviewHost("https://example.com/")).toBeNull();
  expect(classifyPreviewHost("notaurl")).toBeNull();
});

test("extractPreviewUrl: picks first provider URL out of prose", () => {
  const md = "Some text. Preview: https://my-pr.vercel.app/ — please review. Also https://example.com.";
  expect(extractPreviewUrl(md)).toEqual({ url: "https://my-pr.vercel.app/", provider: "vercel" });
});

test("extractPreviewUrl: strips trailing punctuation", () => {
  expect(extractPreviewUrl("Visit https://x.netlify.app.")).toEqual({
    url: "https://x.netlify.app",
    provider: "netlify",
  });
});

test("extractPreviewUrl: returns null when no provider URL", () => {
  expect(extractPreviewUrl("https://example.com only")).toBeNull();
  expect(extractPreviewUrl("")).toBeNull();
});

test("probePreview: finds URL in PR body on first fetch", async () => {
  const pr = "https://github.com/o/r/pull/7";
  const fetchFn = fetchScript({
    "https://api.github.com/repos/o/r/pulls/7": mockRes({
      body: "Preview at https://feature.vercel.app",
    }),
  });
  const r = await probePreview(pr, { fetchFn, nowFn: now });
  expect(r.preview_url).toBe("https://feature.vercel.app");
  expect(r.provider).toBe("vercel");
  expect(r.probed_at).toBe(FIXED_NOW);
  expect(r.skip_reason).toBeUndefined();
});

test("probePreview: falls through to issue comments", async () => {
  const pr = "https://github.com/o/r/pull/8";
  const fetchFn = fetchScript({
    "https://api.github.com/repos/o/r/pulls/8": mockRes({ body: "no preview here" }),
    "https://api.github.com/repos/o/r/issues/8/comments": mockRes([
      { body: "WIP" },
      { body: "Deploy preview ready: https://pr-8.netlify.app" },
    ]),
  });
  const r = await probePreview(pr, { fetchFn, nowFn: now });
  expect(r.preview_url).toBe("https://pr-8.netlify.app");
  expect(r.provider).toBe("netlify");
});

test("probePreview: returns null when no preview anywhere", async () => {
  const pr = "https://github.com/o/r/pull/9";
  const fetchFn = fetchScript({
    "https://api.github.com/repos/o/r/pulls/9": mockRes({ body: "no" }),
    "https://api.github.com/repos/o/r/issues/9/comments": mockRes([]),
    "https://api.github.com/repos/o/r/pulls/9/comments": mockRes([]),
  });
  const r = await probePreview(pr, { fetchFn, nowFn: now });
  expect(r.preview_url).toBeNull();
  expect(r.skip_reason).toContain("no preview URL");
});

test("probePreview: bails on 404 immediately", async () => {
  const pr = "https://github.com/o/r/pull/10";
  let calls = 0;
  const fetchFn: FetchFn = async () => {
    calls++;
    return mockRes("", 404);
  };
  const r = await probePreview(pr, { fetchFn, nowFn: now });
  expect(calls).toBe(1);
  expect(r.preview_url).toBeNull();
  expect(r.skip_reason).toContain("404");
});

test("probePreview: bails on 403 rate-limit", async () => {
  const pr = "https://github.com/o/r/pull/11";
  let calls = 0;
  const fetchFn: FetchFn = async () => {
    calls++;
    return mockRes("", 403);
  };
  const r = await probePreview(pr, { fetchFn, nowFn: now });
  expect(calls).toBe(1);
  expect(r.skip_reason).toContain("403");
});

test("probePreview: catches fetch errors and returns skip reason", async () => {
  const fetchFn: FetchFn = async () => { throw new Error("connreset"); };
  const r = await probePreview("https://github.com/o/r/pull/12", { fetchFn, nowFn: now });
  expect(r.preview_url).toBeNull();
  expect(r.skip_reason).toContain("connreset");
});

test("probePreview: unrecognized PR URL skips without fetching", async () => {
  let calls = 0;
  const fetchFn: FetchFn = async () => { calls++; return mockRes(""); };
  const r = await probePreview("https://gitlab.com/foo/bar/pull/1", { fetchFn, nowFn: now });
  expect(calls).toBe(0);
  expect(r.skip_reason).toBe("unrecognized PR url");
});

test("probePreview: token is sent as Bearer auth header", async () => {
  const seen: { headers?: Record<string, string> }[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    seen.push({ headers: init?.headers });
    return mockRes({ body: "https://x.vercel.app" });
  };
  await probePreview("https://github.com/o/r/pull/1", { fetchFn, nowFn: now, token: "ghp_x" });
  expect(seen[0]!.headers!.Authorization).toBe("Bearer ghp_x");
});

test("probeBatch: returns one result per candidate", async () => {
  const fetchFn = fetchScript({
    "https://api.github.com/repos/o/r/pulls/1": mockRes({ body: "https://a.vercel.app" }),
    "https://api.github.com/repos/o/r/pulls/2": mockRes({ body: "no" }),
    "https://api.github.com/repos/o/r/issues/2/comments": mockRes([]),
    "https://api.github.com/repos/o/r/pulls/2/comments": mockRes([]),
  });
  const out = await probeBatch(
    [
      { id: "i-1", pr_url: "https://github.com/o/r/pull/1" },
      { id: "i-2", pr_url: "https://github.com/o/r/pull/2" },
    ],
    { fetchFn, nowFn: now },
  );
  expect(out.map((r) => r.id)).toEqual(["i-1", "i-2"]);
  expect(out[0]!.preview_url).toBe("https://a.vercel.app");
  expect(out[1]!.preview_url).toBeNull();
});

test("formatEventPayload: matches expected shape", () => {
  expect(formatEventPayload({
    id: "x", pr_url: "p", preview_url: "https://x.vercel.app", provider: "vercel", probed_at: 0,
  })).toBe("provider: vercel\nurl: https://x.vercel.app");
  expect(formatEventPayload({
    id: "x", pr_url: "p", preview_url: null, provider: null, probed_at: 0, skip_reason: "no preview",
  })).toBe("skip: no preview");
});
