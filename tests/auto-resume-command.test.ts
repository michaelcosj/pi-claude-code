import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import claudeCodeExtension from "../src/index.ts";
import { AUTO_RESUME_ENTRY } from "../src/usage-limits.ts";

test("auto-resume command toggles, persists per branch, restores on resume/tree, and rejects invalid arguments", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  let branch: Array<{ type: string; customType: string; data: { enabled: boolean } }> = [];
  const notices: string[] = [];
  const api = {
    registerProvider() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, command); },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) { events.set(name, handler); },
    appendEntry(customType: string, data: { enabled: boolean }) { branch.push({ type: "custom", customType, data }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string) => notices.push(message), setStatus() {} },
  } as unknown as ExtensionCommandContext;
  claudeCodeExtension(api);
  const command = commands.get("claude-code-auto-resume")!;
  events.get("session_start")!({}, ctx);
  await command.handler("status", ctx);
  assert.match(notices.at(-1)!, /OFF/);
  assert.equal(branch.length, 0);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /ON/);
  assert.deepEqual(branch.at(-1), { type: "custom", customType: AUTO_RESUME_ENTRY, data: { enabled: true } });
  await command.handler("off", ctx);
  assert.match(notices.at(-1)!, /OFF/);
  const count = branch.length;
  await command.handler("invalid", ctx);
  assert.match(notices.at(-1)!, /^Usage:/);
  assert.equal(branch.length, count);
  branch = [{ type: "custom", customType: AUTO_RESUME_ENTRY, data: { enabled: true } }];
  events.get("session_start")!({}, ctx);
  await command.handler("status", ctx);
  assert.match(notices.at(-1)!, /ON/);
  branch = [];
  events.get("session_tree")!({}, ctx);
  await command.handler("status", ctx);
  assert.match(notices.at(-1)!, /OFF/);
  events.get("session_shutdown")!({}, ctx);
});
