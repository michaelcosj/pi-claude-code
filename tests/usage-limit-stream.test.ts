import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type AssistantMessageEvent, type Message } from "@earendil-works/pi-ai";
import type { RunClaudeOutput } from "../src/claude-cli.ts";
import { CLAUDE_CODE_MODELS } from "../src/model-catalog.ts";
import { streamClaudeCode } from "../src/stream.ts";
import { ClaudeRateLimitError, UsageLimitController } from "../src/usage-limits.ts";

const now = Date.parse("2026-10-24T11:32:00Z");
const at = now / 1000 + 120;
const upstream = "This request would exceed your account's rate limit. Please try again later.";
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: now }] });
const response: RunClaudeOutput = {
  message: { id: "m", role: "assistant", content: [{ type: "text", text: "resumed" }], stop_reason: "end_turn" },
  result: { type: "result", subtype: "success", is_error: false },
  usage: { input_tokens: 3, output_tokens: 1 }, exitCode: 0,
  relay: { upstreamRequests: 1, blockedRequests: 0 },
};

// Substitute only the request inside the real controller: stream lifecycle,
// error normalization, waiting and translation all execute without live traffic.
class FixtureController extends UsageLimitController {
  calls = 0;
  constructor(private readonly rejectOnly: boolean, clock?: ConstructorParameters<typeof UsageLimitController>[0]) { super(clock); }
  override run<T>(_request: () => Promise<T>, messages: Message[], signal?: AbortSignal): Promise<T> {
    return super.run(async () => {
      this.calls++;
      if (this.rejectOnly || this.calls === 1) throw new ClaudeRateLimitError(upstream, { resetsAt: at, rateLimitType: "seven_day" });
      return structuredClone(response) as T;
    }, messages, signal);
  }
}

test("stream emits a descriptive terminal error and preserves reset diagnostics when auto-resume is off", async () => {
  const controller = new FixtureController(true, { now: () => now, sleep: async () => { assert.fail("must not sleep"); } });
  const stream = streamClaudeCode(CLAUDE_CODE_MODELS[0]!, context, undefined, controller);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /billing\/usage limit \(HTTP 429\)/);
  assert.match(message.errorMessage!, /Auto-resume is off/);
  assert.equal(events.filter((event) => event.type === "error").length, 1);
  assert.equal(events.filter((event) => event.type === "done").length, 0);
  assert.equal(message.diagnostics?.[0]?.details?.resetsAt, at);
});

test("resumption stays within one balanced assistant stream instead of emitting an intermediate error", async () => {
  let time = now;
  const controller = new FixtureController(false, { now: () => time, sleep: async (ms) => { time += ms; } });
  controller.setEnabled(true);
  const stream = streamClaudeCode(CLAUDE_CODE_MODELS[0]!, context, undefined, controller);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.equal(controller.calls, 2);
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "resumed" }]);
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.filter((event) => event.type === "text_start").length, 1);
  assert.equal(events.filter((event) => event.type === "text_end").length, 1);
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(events.filter((event) => event.type === "error").length, 0);
});
