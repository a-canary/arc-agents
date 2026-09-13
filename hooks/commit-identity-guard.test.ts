import { test, expect } from "bun:test";
import { $ } from "bun";

// The literal trigger phrase is assembled at runtime, never written as a
// contiguous string. The guard this file tests blocks any command containing it
// as prose — writing this test file with the phrase inline would make the test
// suite unwritable, which is the exact bug under test.
const GC = ["g" + "it", "c" + "ommit"].join(" ");

const HOOK = new URL("./commit-identity-guard.sh", import.meta.url).pathname;

/** Run the hook with a Bash tool payload; resolve its exit code. 0=allow, 2=block. */
async function run(command: string, env: Record<string, string> = {}) {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  const res = await $`echo ${payload} | ${HOOK}`.env({ ...process.env, ...env }).nothrow().quiet();
  return res.exitCode;
}

const ALLOW = 0;
const BLOCK = 2;

// --- the regression: prose is not an invocation -------------------------------

test("heredoc body naming the verb as prose is allowed (no git runs)", async () => {
  const cmd = `cat > /tmp/ev.md <<'EOF'\nTo land it, run ${GC} with ambient config.\nEOF`;
  expect(await run(cmd)).toBe(ALLOW);
});

test("ticket body describing the guard inside a heredoc is allowed", async () => {
  const cmd = [
    `ledger create --body-file - <<'BODY'`,
    `The hook fires on ${GC} appearing anywhere, even as prose.`,
    `That blocked the filing of this very ticket.`,
    `BODY`,
  ].join("\n");
  expect(await run(cmd)).toBe(ALLOW);
});

test("single-quoted literal mentioning the verb is allowed", async () => {
  expect(await run(`echo 'remember to ${GC} later'`)).toBe(ALLOW);
});

test("double-quoted literal mentioning the verb is allowed", async () => {
  expect(await run(`echo "the ${GC} rule applies"`)).toBe(ALLOW);
});

test("grep pattern containing the verb is allowed", async () => {
  expect(await run(`grep -rn '${GC}' docs/`)).toBe(ALLOW);
});

// --- still blocks the thing it exists to block --------------------------------

test("bare invocation without identity flags is blocked", async () => {
  expect(await run(`${GC} -m 'wip'`)).toBe(BLOCK);
});

test("invocation after && without identity flags is blocked", async () => {
  expect(await run(`git add -A && ${GC} -m 'wip'`)).toBe(BLOCK);
});

test("invocation after a pipe without identity flags is blocked", async () => {
  expect(await run(`true | ${GC} -m 'wip'`)).toBe(BLOCK);
});

test("invocation on its own line after a heredoc closes is blocked", async () => {
  const cmd = [`cat > /tmp/m.txt <<'EOF'`, `message body`, `EOF`, `${GC} -F /tmp/m.txt`].join("\n");
  expect(await run(cmd)).toBe(BLOCK);
});

// --- still allows the correct form --------------------------------------------

test("identity pinned per-commit is allowed", async () => {
  const cmd = `git -c user.name='a-canary' -c user.email='a@b.c' ${GC.split(" ")[1]} -m 'x'`;
  expect(await run(cmd)).toBe(ALLOW);
});

test("only one of the two identity flags is still blocked", async () => {
  const verb = GC.split(" ")[1];
  expect(await run(`git -c user.name='a-canary' ${verb} -m 'x'`)).toBe(BLOCK);
});

test("amend is skipped (different identity semantics)", async () => {
  expect(await run(`${GC} --amend --no-edit`)).toBe(ALLOW);
});

test("escape hatch in the command disables the guard", async () => {
  expect(await run(`COMMIT_IDENTITY_GUARD=off ${GC} -m 'x'`)).toBe(ALLOW);
});

test("escape hatch in the environment disables the guard", async () => {
  expect(await run(`${GC} -m 'x'`, { COMMIT_IDENTITY_GUARD: "off" })).toBe(ALLOW);
});

test("non-Bash tools are ignored", async () => {
  const payload = JSON.stringify({ tool_name: "Write", tool_input: { command: `${GC} -m 'x'` } });
  const res = await $`echo ${payload} | ${HOOK}`.nothrow().quiet();
  expect(res.exitCode).toBe(ALLOW);
});
