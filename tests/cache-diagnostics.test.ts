import assert from "node:assert/strict";
import test from "node:test";
import { cacheDiagnostics } from "../src/cache-diagnostics.ts";

const marker = { type: "ephemeral", ttl: "1h" };
const prompt = () => ({
  model: "claude",
  tools: [{ name: "private-tool", input_schema: { type: "object" } }],
  system: [{ type: "text", text: "private-system", cache_control: marker }],
  messages: [{ role: "user", content: [{ type: "text", text: "private-message", cache_control: marker }] }],
});
const inspect = (payload: unknown, session?: string, started?: number) => cacheDiagnostics(Buffer.from(JSON.stringify(payload)), session, started);
const usage = { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 80, cache_creation_input_tokens: 18, cache_creation: { ephemeral_1h_input_tokens: 18, ephemeral_5m_input_tokens: 0 } };

test("compares successful requests across workers without exposing prompt content or the session id", () => {
  const first = inspect(prompt(), "private-session", 1000);
  assert.equal(first.request.comparison, "no-baseline");
  const completed = first.finish(usage, true);
  assert.deepEqual(completed.usage, { input: 2, output: 3, cacheRead: 80, cacheWrite: 18, cacheWrite1h: 18, cacheWrite5m: 0, readShare: 0.8 });
  const next = prompt();
  delete (next.messages[0]!.content[0] as { cache_control?: unknown }).cache_control;
  next.messages.push({ role: "assistant", content: [{ type: "text", text: "reply", cache_control: marker }] });
  const second = inspect(next, "private-session", 2000);
  assert.equal(second.request.comparison, "append-only");
  assert.equal(second.request.previousTurn, first.request.turn);
  assert.equal(second.request.sincePreviousStartMs, 1000);
  assert.equal(second.request.matchedBlocks, 3);
  assert.deepEqual(second.request.changedFields, []);
  assert.equal(second.request.previousBreakpoints?.[1]?.currentPath, "messages[0].content[0]");
  assert.equal(second.request.breakpoints.at(-1)?.path, "messages[1].content[0]");
  assert.equal(second.request.breakpoints.at(-1)?.ttl, "1h");
  assert.ok(!JSON.stringify([completed, second.request]).includes("private-"));
});

test("locates the first changed content block and detects tools, system, and thinking changes", () => {
  const original = prompt();
  inspect(original, "changes").finish(undefined, true);
  const changed = prompt();
  changed.messages[0]!.content[0]!.text = "edited";
  const messageDiff = inspect(changed, "changes").request;
  assert.equal(messageDiff.comparison, "prefix-changed");
  assert.equal(messageDiff.firstDifference?.currentPath, "messages[0].content[0]");
  assert.equal(messageDiff.previousBreakpoints?.[1]?.currentPath, null);
  assert.equal(messageDiff.previousBreakpoints?.[0]?.currentPath, "system[0]");
  for (const field of ["tools", "system", "thinking", "model"] as const) {
    const result = inspect({ ...original, [field]: "changed" }, "changes").request;
    assert.equal(result.comparison, "prefix-changed");
    assert.deepEqual(result.changedFields, [field]);
    assert.ok(result.previousBreakpoints?.every((point) => point.currentPath === null) || field === "system");
  }
  const shorter = inspect({ ...original, messages: [] }, "changes").request;
  assert.equal(shorter.comparison, "prefix-changed");
  assert.equal(shorter.firstDifference?.previousPath, "messages[0].content[0]");
  assert.equal(shorter.firstDifference?.currentPath, undefined);
});

test("metadata and moved cache markers do not imply changed prompt content", () => {
  const original = { ...prompt(), metadata: { user_id: "one" }, max_tokens: 100 };
  inspect(original, "metadata").finish(undefined, true);
  const result = inspect({ ...original, metadata: { user_id: "two" }, max_tokens: 200 }, "metadata").request;
  assert.equal(result.comparison, "unchanged");
  assert.deepEqual(result.changedFields, []);
});

test("failed responses do not replace baselines, and unrelated or one-off requests never share one", () => {
  const baseline = inspect(prompt(), "failures");
  baseline.finish(undefined, true);
  inspect({ ...prompt(), system: "failed change" }, "failures").finish(undefined, false);
  const next = inspect(prompt(), "failures");
  assert.equal(next.request.comparison, "unchanged");
  assert.equal(next.request.previousTurn, baseline.request.turn);
  assert.equal(inspect(prompt(), "different-session").request.comparison, "no-baseline");
  inspect(prompt()).finish(undefined, true);
  assert.equal(inspect(prompt()).request.comparison, "no-baseline");
  assert.equal(next.finish(undefined, false).usage, undefined);
});

test("concurrent requests finishing out of order do not move the baseline backwards", () => {
  const slow = inspect(prompt(), "concurrent", 1000);
  const fast = inspect({ ...prompt(), system: "newer" }, "concurrent", 2000);
  fast.finish(undefined, true);
  slow.finish(undefined, true);
  assert.equal(inspect(prompt(), "concurrent", 3000).request.previousTurn, fast.request.turn);
});

test("cache_control inside tool input is content, not a cache marker", () => {
  const payload = { messages: [{ role: "assistant", content: [{ type: "tool_use", input: { cache_control: "one" } }] }] };
  inspect(payload, "tool-input").finish(undefined, true);
  payload.messages[0]!.content[0]!.input.cache_control = "two";
  assert.equal(inspect(payload, "tool-input").request.comparison, "prefix-changed");
});
