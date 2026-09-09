// Dedup logic for `ledger hygiene-emit`. Pure: takes (skill, candidate title,
// existing rows) and returns a verdict. Caller decides what to do with it.
//
// Goal: stop a worker from spawning N copies of the same observation across
// successive slices. Two rows are "duplicate enough" when they share the same
// hygiene skill AND their normalized titles match by either:
//   1. identical normalized form, OR
//   2. one is a substring of the other (after normalize), OR
//   3. Levenshtein distance <= threshold * max(len_a, len_b).
//
// Threshold default 0.25 — tuned for short hygiene titles where small edits
// ("rename foo" vs "rename Foo helper") should collide, but distinct
// observations ("dead import in x.ts" vs "dead import in y.ts") should not.

export type ExistingRow = {
  id: string;
  title: string;
  tier: string;
  state: string;
  skill?: string | null;
};

export type DedupVerdict =
  | { duplicate: false }
  | { duplicate: true; existingId: string; reason: "exact" | "substring" | "levenshtein" };

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[a-z-]+:\s*/, "")       // strip "clarify-docs: " skill prefix if present
    .replace(/[^a-z0-9\s]/g, " ")      // collapse punctuation to spaces
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export type DedupOptions = {
  threshold?: number;        // distance / max-len ratio, default 0.25
  considerStates?: string[]; // existing rows to consider, default ['ready','blocked','wip','claimed']
};

export function checkDuplicate(
  skill: string,
  candidateTitle: string,
  existing: ExistingRow[],
  opts: DedupOptions = {},
): DedupVerdict {
  const threshold = opts.threshold ?? 0.25;
  const considerStates = opts.considerStates ?? ["ready", "blocked", "wip", "claimed"];
  const cand = normalizeTitle(candidateTitle);
  if (cand.length === 0) return { duplicate: false };

  for (const row of existing) {
    if (row.tier !== "hygiene") continue;
    if (!considerStates.includes(row.state)) continue;
    // Skill match: prefer explicit row.skill if present, otherwise infer from title prefix.
    const rowSkill = row.skill ?? inferSkillFromTitle(row.title);
    if (rowSkill !== skill) continue;

    const other = normalizeTitle(row.title);
    if (other.length === 0) continue;

    if (other === cand) return { duplicate: true, existingId: row.id, reason: "exact" };
    if (other.includes(cand) || cand.includes(other)) {
      return { duplicate: true, existingId: row.id, reason: "substring" };
    }
    const dist = levenshtein(cand, other);
    const ratio = dist / Math.max(cand.length, other.length);
    if (ratio <= threshold) {
      return { duplicate: true, existingId: row.id, reason: "levenshtein" };
    }
  }
  return { duplicate: false };
}

// Best-effort skill inference from "<skill>: <observation>" title convention
// used by Slice A's clarify-docs skill doc. Returns null if no recognized
// prefix is present.
const KNOWN_HYGIENE_SKILLS = [
  "clarify-docs",
  "improve-architecture",
  "trash-retired-files",
  "analyse-recent-sessions",
];

export function inferSkillFromTitle(title: string): string | null {
  const m = title.match(/^([a-z-]+):\s*/i);
  if (!m) return null;
  const candidate = m[1]!.toLowerCase();
  return KNOWN_HYGIENE_SKILLS.includes(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// General task dedup (not hygiene-tier). Motivated by three workers being
// dispatched at one defect: the three rows had *dissimilar titles* but every
// body named the same file (bin/write-lane-gate.test.ts). Title similarity
// alone would not have caught it, so the primary signal here is the set of
// source paths mentioned in title+body.
//
// ponytail: advisory only — `create` reports the overlap and still inserts.
// A hard block on creation is the wrong failure mode: creation is the only
// way work enters the ledger, so a false positive strands real work, while a
// false negative just costs one duplicate worker. Promote to a block only if
// the advisory proves near-zero false-positive in practice.

// Paths that look like repo source files: a/b/c.ts, bin/foo.sh, src/x/y.tsx.
// Deliberately narrow — bare words and bare filenames produce too many
// collisions to be a useful signal.
const PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)+\.[a-z]{1,5}\b/gi;

export function extractPaths(text: string): string[] {
  const hits = text.match(PATH_RE) ?? [];
  return [...new Set(hits.map((p) => p.toLowerCase()))];
}

export type TaskDedupCandidate = {
  title: string;
  body: string;
  project: string;
};

export type TaskDedupHit = {
  existingId: string;
  reason: "shared-path" | "title";
  detail: string;
};

export type ExistingTaskRow = ExistingRow & { body: string; project: string };

// Returns every open row in the same project that overlaps the candidate,
// most-specific signal first. Empty array = no overlap found.
export function checkTaskDuplicate(
  candidate: TaskDedupCandidate,
  existing: ExistingTaskRow[],
  opts: DedupOptions = {},
): TaskDedupHit[] {
  const threshold = opts.threshold ?? 0.25;
  const considerStates = opts.considerStates ?? ["ready", "blocked", "wip", "claimed", "review"];
  const candPaths = new Set(extractPaths(`${candidate.title}\n${candidate.body}`));
  const candTitle = normalizeTitle(candidate.title);
  const hits: TaskDedupHit[] = [];

  for (const row of existing) {
    if (row.project !== candidate.project) continue;
    if (!considerStates.includes(row.state)) continue;

    const shared = extractPaths(`${row.title}\n${row.body}`).filter((p) => candPaths.has(p));
    if (shared.length > 0) {
      hits.push({ existingId: row.id, reason: "shared-path", detail: shared.join(", ") });
      continue;
    }

    const other = normalizeTitle(row.title);
    if (candTitle.length === 0 || other.length === 0) continue;
    const ratio = levenshtein(candTitle, other) / Math.max(candTitle.length, other.length);
    if (ratio <= threshold) {
      hits.push({ existingId: row.id, reason: "title", detail: row.title });
    }
  }
  return hits;
}
