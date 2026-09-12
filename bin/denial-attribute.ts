#!/usr/bin/env bun
// denial-attribute — attribute permission denials in a session transcript to
// the tool call that caused them.
//
// A denial arrives as a `tool_result` whose text is harness boilerplate
// ("...denied by the Claude Code auto mode classifier. Reason: Blocked by
// classifier.") — constant across every denial, so a denial cluster looks
// unattributable. It is not: the result carries a `tool_use_id` pointing at
// the `tool_use` block that holds the tool name and full input. This joins
// the two so the cluster becomes actionable.
//
// Usage:  denial-attribute.ts <session.jsonl> [more.jsonl ...]
//         denial-attribute.ts --tally <session.jsonl> ...
// Exit:   0 always when files parsed (a denial is data, not an error), 2 usage
//
import { readFileSync } from "node:fs";

export interface Denial {
  toolUseId: string;
  tool: string; // "Bash", "Write", ... ; "<unresolved>" if the use block is absent
  args: string; // Bash command, else JSON of the input
  reason: string; // the harness reason text, deduped
}

// Matches the auto-mode classifier denial and the plain permission denial.
const DENIAL = /permission(?:s)? (?:for this action )?(?:was |were )?denied|denied by the Claude Code/i;
const REASON = /Reason:\s*([^\n.]+)/;

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

// ponytail: one transcript held in memory at a time. Sessions run ~MBs; if a
// transcript ever outgrows RAM, upgrade path = two streaming passes (collect
// denied ids, then resolve) instead of one map of every tool_use.
export function attributeDenials(jsonl: string): Denial[] {
  const uses = new Map<string, ToolUse>();
  const denied: { id: string; reason: string }[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a truncated tail line is not worth failing the whole report
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        uses.set(block.id, { name: block.name ?? "<unknown>", input: block.input ?? {} });
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        // Result content is either a string or an array of text blocks.
        const text = Array.isArray(block.content)
          ? block.content.map((c: any) => c?.text ?? "").join("\n")
          : String(block.content ?? "");
        if (!DENIAL.test(text)) continue;
        denied.push({ id: block.tool_use_id, reason: text.match(REASON)?.[1]?.trim() ?? "unspecified" });
      }
    }
  }

  // Dedupe by tool_use_id: a transcript replays earlier turns, so the same
  // denial appears in many records. Each denied call should count once.
  const seen = new Set<string>();
  const out: Denial[] = [];
  for (const d of denied) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const use = uses.get(d.id);
    out.push({
      toolUseId: d.id,
      tool: use?.name ?? "<unresolved>",
      args: use ? argsOf(use) : "",
      reason: d.reason,
    });
  }
  return out;
}

function argsOf(use: ToolUse): string {
  const cmd = use.input.command;
  const s = typeof cmd === "string" ? cmd : JSON.stringify(use.input);
  return s.replace(/\s+/g, " ").trim();
}

// Group denials by tool + a coarse shape of the command, so a cluster of 12
// `git worktree remove` calls reads as one cause rather than 12 incidents.
export function tally(denials: Denial[]): { key: string; count: number; example: string }[] {
  const groups = new Map<string, { count: number; example: string }>();
  for (const d of denials) {
    const key = `${d.tool}\t${shapeOf(d.args)}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, example: d.args });
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...g }))
    .sort((a, b) => b.count - a.count);
}

// The verb-ish head of a command: enough to cluster, not enough to leak paths.
// `cd x && git worktree remove --force /p` → `git worktree remove`.
export function shapeOf(args: string): string {
  // Drop a leading `cd <path> &&` first: taking the first chain segment before
  // stripping it would leave only `cd` and lose the command that was denied.
  // The separator is optional: a multi-line `cd p\n git ...` flattens to a
  // bare space, so requiring `&&` would split the cluster on formatting alone.
  const body = args.trim().replace(/^cd\s+\S+\s*(?:&&|;)?\s*/, "");
  const words = body
    .split(/&&|\|\||[;|]/)[0]! // first command in the chain
    .trim()
    .split(/\s+/)
    .filter((w) => w && !w.startsWith("-") && !w.includes("/") && !w.startsWith("2>"));
  return words.slice(0, 3).join(" ") || body.split(/\s+/)[0] || "";
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const doTally = argv[0] === "--tally";
  const files = doTally ? argv.slice(1) : argv;
  if (files.length === 0) {
    console.error("usage: denial-attribute.ts [--tally] <session.jsonl> ...");
    process.exit(2);
  }

  const all = files.flatMap((f) => attributeDenials(readFileSync(f, "utf8")));
  if (all.length === 0) {
    console.log("no permission denials found");
  } else if (doTally) {
    console.log(`${all.length} denial(s) across ${files.length} transcript(s)\n`);
    for (const t of tally(all)) {
      const [tool, shape] = t.key.split("\t");
      console.log(`${String(t.count).padStart(4)}  ${tool}: ${shape}`);
      console.log(`      e.g. ${t.example.slice(0, 120)}`);
    }
  } else {
    for (const d of all) {
      console.log(`${d.tool}\t${d.reason}\t${d.args.slice(0, 200)}`);
    }
  }
}
