import assert from "node:assert/strict";
import * as http from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedClaudeProcessCount, closeClaudeProcesses, runClaudeRequest } from "../src/claude-cli.ts";
import { relayLogPath } from "../src/relay-log.ts";
import { ClaudeRateLimitError, UsageLimitController } from "../src/usage-limits.ts";

test("real relay 429s carry safe reset metadata, release the worker, and resume only when opted in", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-limit-"));
  const executable = join(root, "fake-claude.mjs");
  let calls = 0;
  let rejects = 1;
  let resetHeader = true;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    calls++;
    if (rejects-- > 0) {
      response.writeHead(429, { "content-type": "application/json", "x-private": "header-secret",
        ...(resetHeader ? { "retry-after": "1" } : {}) });
      response.end(JSON.stringify({ error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } }));
      return;
    }
    const usage = { input_tokens: 3, output_tokens: 1 };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      { type: "message_start", message: { id: "m", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
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
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST", body: JSON.stringify({ model: "sonnet", messages: [frame.message] })
  });
  await response.text();
  console.log(JSON.stringify({ type: "result", subtype: response.ok ? "success" : "error_during_execution", is_error: !response.ok }));
}
`);
  await chmod(executable, 0o755);
  const request = () => runClaudeRequest({
    model: "sonnet", frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }],
    systemPrompt: "system", manifest: [], extraBody: {},
    upstreamUrl: `http://127.0.0.1:${address.port}`, sessionId: "limit-fixture",
    env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000,
  });
  let time = Date.now();
  const clock = { now: () => time, sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); time += ms; } };
  const controller = new UsageLimitController(clock);
  try {
    await assert.rejects(controller.run(request, []), (error: unknown) => {
      assert.ok(error instanceof ClaudeRateLimitError);
      assert.ok(error.rateLimit?.retryAfterAt);
      assert.match(error.message, /HTTP 429.*Reported usage reset/);
      assert.match(error.message, /Auto-resume is off/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cachedClaudeProcessCount(), 0);

    rejects = 1;
    controller.setEnabled(true);
    let waitingWorkerCount: number | undefined;
    controller.onWait = (message) => {
      if (message) waitingWorkerCount = cachedClaudeProcessCount();
    };
    const result = await controller.run(request, []);
    assert.equal(waitingWorkerCount, 0, "the failed Claude worker must be closed before waiting");
    assert.equal(result.message.content[0]?.type, "text");
    assert.equal(calls, 3, "exactly one rejected request and one retry");
    assert.equal(controller.waiting, undefined);

    rejects = 1;
    resetHeader = false;
    await assert.rejects(controller.run(request, []), /No future reset time is available/);
    assert.equal(calls, 4, "no polling when no reset is known");
    const records = (await readFile(relayLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .filter((record) => record.upstream === `http://127.0.0.1:${address.port}`);
    assert.equal(typeof records[0].rateLimit.retryAfterAt, "number");
    assert.equal(records.at(-1).rateLimit, undefined, "metadata does not leak between turns");
    assert.ok(!JSON.stringify(records).includes("header-secret"));
  } finally {
    await closeClaudeProcesses();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
