#!/usr/bin/env bun
// chat-reply — Reply endpoint for ADR 0010 reply flow.
//
// Receives a user reply to a blog post:
//   1. Appends a {ts, role:"user", body, blog_id, task_id, spawned:[]} line
//      to arc-ux/chat/<blog_id>.jsonl.
//   2. Creates a 'read chat file and react' issues row (kind=task, tier=mvp,
//      pool=build) referencing the blog_id and chat file path.
//   3. Emits the chat line + issue id to stdout as JSON.
//
// This is the "server" side of the reply flow described in ADR 0010.
// arc-webui calls this, gets back the issue id, and shows it in the UI.
//
// Usage (CLI):
//   bun bin/chat-reply.ts --blog-id <id> --body "<text>" [--project <project>]
//
// Usage (programmatic):
//   import { handleReply } from "./chat-reply";
//   handleReply({ blog_id, body, project, chatRoot? })
//
// Environment:
//   ARC_CHAT_ROOT    directory for arc-ux/chat/ JSONL files
//                    (default: ~/vault/arc-ux/chat)

import { open, mintId } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { appendChatLine, chatPath, type ChatLine } from "../src/ledger/chat";

const args = process.argv.slice(2);

// ─── CLI ─────────────────────────────────────────────────────────────────────

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}

function die(msg: string, code = 1): never {
  console.error(`chat-reply: ${msg}`);
  process.exit(code);
}

function cli() {
  const blogId = getFlag("blog-id") ?? die("--blog-id required");
  const body = getFlag("body") ?? die("--body required");
  const project = getFlag("project") ?? "arc-agents";

  const result = handleReply({ blog_id: blogId, body, project });
  process.stdout.write(JSON.stringify(result) + "\n");
}

// ─── Core logic ─────────────────────────────────────────────────────────────

export interface ReplyResult {
  chat_line: ChatLine;
  issue_id: string;
}

export interface HandleReplyOptions {
  blog_id: string;
  body: string;
  project: string;
  chatRoot?: string;
}

export function handleReply(opts: HandleReplyOptions): ReplyResult {
  const { blog_id, body, project, chatRoot } = opts;

  const db = open();
  migrate(db);

  // 1. Append chat line (creates task_id = random UUID)
  const chatLine = appendChatLine(
    { role: "user", body, blog_id },
    chatRoot,
  );

  // 2. Create the 'read chat file and react' issues row
  const issueId = mintId(db, `read chat file and react: ${blog_id}`);
  const chatFilePath = chatPath(blog_id, chatRoot ?? process.env.ARC_CHAT_ROOT);

  db.run(
    `INSERT INTO issues
       (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, source_module)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      issueId,
      project,
      `read chat file and react: ${blog_id}`,
      JSON.stringify({
        action: "read_chat_and_react",
        blog_id,
        chat_file: chatFilePath,
        task_id: chatLine.task_id,
        initial_body: body,
      }),
      `Read ${chatFilePath}, react to user message (${body.slice(0, 50)}...). Write spawned issue ids back into the chat line's spawned array.`,
      "mvp",    // type
      "ready",  // state
      "task",   // kind
      "mvp",    // tier
      "build",  // pool
      "chat",   // agent (chat family — matches AGENT_VALUES enum)
      "chat-reply", // source_module (informational)
    ],
  );

  // Emit 'created' event on the new issue
  db.run(
    `INSERT INTO issue_events (issue_id, agent, kind, payload_md)
     VALUES (?, ?, 'created', ?)`,
    [issueId, "chat-reply", `User replied to blog post ${blog_id}: ${body.slice(0, 100)}`],
  );

  db.close();

  return { chat_line: chatLine, issue_id: issueId };
}

// ─── Main ────────────────────────────────────────────────────────────────────

if (import.meta.main) cli();
