// Parse an analyse-recent-sessions report's "Recommended follow-up rows to
// file" markdown table into {title, type, body} specs. Pure: no fs, no db.
// The first markdown table under any heading matching /Recommended follow-up/
// is the data source. Title is the first backticked slug; type is the first
// known TYPE word in the cells after the title; body is the rest.

export type FollowupRow = { title: string; type: string; body: string };

const TYPES = /\b(interactive|hitl|cron|mvp|security|quality|scale|efficiency|deferred)\b/i;

export function parseFollowupTable(md: string): FollowupRow[] {
  const h = md.match(/^#{1,6}\s+.*[Rr]ecommended\s+follow-?up.*$/m);
  if (!h || h.index === undefined) return [];
  const tail = md.slice(h.index + h[0].length);
  const tAt = tail.search(/^\s*\|/m);
  if (tAt < 0) return [];
  const rows = tail.slice(tAt).split("\n").filter((l) => l.trim().startsWith("|"));
  if (rows.length < 3) return [];
  const out: FollowupRow[] = [];
  for (const line of rows.slice(2)) {
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const title = cells.join(" ").match(/`([a-z0-9][a-z0-9-]{2,})`/i)?.[1];
    if (!title) continue;
    const after = cells.slice(cells.findIndex((c) => c.includes("`" + title + "`")) + 1);
    const type = after.join(" ").match(TYPES)?.[1]?.toLowerCase() ?? "quality";
    const body = (after.length ? after : cells).filter((c) => c !== "`" + title + "`").join(" ").trim() || title;
    out.push({ title, type, body });
  }
  return out;
}
