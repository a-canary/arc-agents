import { describe, expect, test } from "bun:test";
import { lintCrontab } from "./cron-lint";

const BUN = "/home/aaron/.bun/bin/bun";
const PIN = "PATH=/home/aaron/.bun/bin:/usr/local/bin:/usr/bin:/bin";

describe("lintCrontab", () => {
  test("pinned bun entry passes", () => {
    const tab = `*/5 * * * * ${PIN} ${BUN} /x/y.ts\n`;
    expect(lintCrontab(tab)).toEqual([]);
  });

  test("unpinned bun entry fails", () => {
    const tab = `*/5 * * * * ${BUN} /x/y.ts\n`;
    const v = lintCrontab(tab);
    expect(v).toHaveLength(1);
    expect(v[0]!.line).toBe(1);
  });

  test("unpinned pi entry fails", () => {
    const tab = `0 * * * * /usr/local/bin/pi -p "do a thing"\n`;
    expect(lintCrontab(tab)).toHaveLength(1);
  });

  test(".ts reference without pin fails even with absolute bun path", () => {
    const tab = `17 */2 * * * $HOME/.bun/bin/bun $HOME/repos/x/refresh.ts\n`;
    expect(lintCrontab(tab)).toHaveLength(1);
  });

  test("global PATH env line covers all entries", () => {
    const tab = `${PIN}\n0 * * * * ${BUN} /x/y.ts\n`;
    expect(lintCrontab(tab)).toEqual([]);
  });

  test("plain shell entry is never flagged", () => {
    const tab = `30 3 * * 0 for f in /x/*.log; do tail -n 5 "$f"; done\n`;
    expect(lintCrontab(tab)).toEqual([]);
  });

  test("claude -p entry is not bun/pi — not flagged", () => {
    const tab = `0 */6 * * * flock -n /x.lock claude -p "/director" >> /x.log 2>&1\n`;
    expect(lintCrontab(tab)).toEqual([]);
  });

  test("words containing pi (pip, pipe) are not flagged", () => {
    const tab = `0 * * * * pip install x\n0 * * * * cat a | pipe b\n`;
    expect(lintCrontab(tab)).toEqual([]);
  });

  test("comments and blank lines are skipped", () => {
    const tab = `# ${BUN} /x/y.ts\n\n`;
    expect(lintCrontab(tab)).toEqual([]);
  });

  test("bun inside a PATH= value is not an invocation", () => {
    const tab = `0 * * * * env FOO=${PIN.replace("PATH=", "")} /bin/true\n`;
    expect(lintCrontab(tab)).toEqual([]);
  });

  test("multiple violations keep line numbers", () => {
    const tab = [
      "ok line comment # x",
      `0 * * * * ${BUN} /a.ts`,
      "0 * * * * /bin/true",
      `30 * * * * pi -p hi`,
    ].join("\n");
    const v = lintCrontab(tab);
    expect(v.map((x) => x.line)).toEqual([2, 4]);
  });

  test("bun after && is flagged", () => {
    const tab = `23 * * * * cd /home/aaron/repos/arc-agents && bun bin/gate-triage.ts\n`;
    expect(lintCrontab(tab)).toHaveLength(1);
  });
});
