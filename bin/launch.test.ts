import { test, expect } from "bun:test";
import { buildScript } from "./launch";

test("buildScript emits 4 panes worth of commands with session arc", () => {
  const cmds = buildScript();
  expect(cmds[0]).toMatch(/^new-session -d -s arc /);
  expect(cmds.filter((c) => c.startsWith("split-window")).length).toBe(3);
  expect(cmds.filter((c) => c.includes("select-pane")).length).toBe(4);
  expect(cmds.filter((c) => c.startsWith("send-keys")).length).toBe(4);
});

test("worker panes invoke wait-for-ledger and claude", () => {
  const cmds = buildScript().join("\n");
  expect(cmds).toContain("wait-for-ledger");
  expect(cmds).toContain("--role developer");
  expect(cmds).toContain("--role admin");
  expect(cmds).toContain("/loop 5m");
});
