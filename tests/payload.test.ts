import assert from "node:assert/strict";
import * as http from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeClaudeProcesses, runClaudeRequest } from "../src/claude-cli.ts";

test("onPayload inspects the rewritten request, supports async replacement, and can prevent sending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-payload-"));
  const executable = join(root, "fake-claude.mjs");
  const received: unknown[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(executable, `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(0);
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  const payload = { model: "sonnet", max_tokens: 100, messages: [
    { role: "user", content: [{ type: "text", text: "moving reminder" }, ...frame.message.content] }
  ] };
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST", body: JSON.stringify(payload)
  });
  await response.text();
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
}
`);
  await chmod(executable, 0o755);
  const input = {
    model: "sonnet",
    frames: [{ type: "user" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] } }],
    systemPrompt: "system",
    manifest: [],
    extraBody: {},
    upstreamUrl: `http://127.0.0.1:${address.port}`,
    env: { PI_CLAUDE_CODE_COMMAND: executable },
    timeoutMs: 5_000,
  };
  try {
    let observed: unknown;
    await runClaudeRequest({
      ...input,
      onPayload: async (payload) => {
        await Promise.resolve();
        observed = structuredClone(payload);
        return { ...(payload as object), max_tokens: 42 };
      },
    });
    assert.deepEqual(observed, {
      model: "sonnet", max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    assert.deepEqual(received, [{ ...(observed as object), max_tokens: 42 }]);

    await runClaudeRequest({ ...input, onPayload: () => undefined });
    assert.deepEqual(received[1], observed, "undefined keeps the original payload");
    await assert.rejects(runClaudeRequest({
      ...input,
      onPayload: () => { throw new Error("prefix mismatch"); },
    }), /Incomplete Claude Code upstream response/);
    assert.equal(received.length, 2, "a rejected prefix never reaches the upstream");
  } finally {
    await closeClaudeProcesses();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
