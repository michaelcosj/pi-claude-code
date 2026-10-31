import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { RateLimitInfo } from "../src/billing.ts";
import { ClaudeRateLimitError, describeUsageLimit, findLimitReset, mergeRateLimitInfo, readRateLimitHeaders, UsageLimitController } from "../src/usage-limits.ts";

const now = Date.parse("2026-10-24T11:32:00Z");
const weeklyReset = Date.parse("2026-10-24T17:00:00Z") / 1000;
const upstream = "This request would exceed your account's rate limit. Please try again later.";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(info: RateLimitInfo): AssistantMessage {
  return { role: "assistant", api: "claude-code-stream-json", provider: "claude-code", model: "opus",
    content: [], usage, stopReason: "stop", timestamp: now,
    diagnostics: [{ type: "claude-code.rate-limit", timestamp: now, details: info as never }] };
}
const saved: Message[] = [assistant({ status: "allowed_warning", rateLimitType: "seven_day", resetsAt: weeklyReset,
  unifiedWindows: {
    five_hour: { utilization: 0.61, resetsAt: now / 1000 + 3600 },
    seven_day: { utilization: 0.99, resetsAt: weeklyReset },
  } })];
function fakeClock() {
  let time = now;
  const sleeps: number[] = [];
  return { now: () => time, sleeps, sleep: async (ms: number, signal: AbortSignal) => {
    signal.throwIfAborted(); sleeps.push(ms); time += ms;
  } };
}

test("parses only allowlisted, typed limit headers and both Retry-After forms", () => {
  const info = readRateLimitHeaders({
    "retry-after": "120", "authorization": "secret", "x-private": "private",
    "anthropic-ratelimit-unified-reset": String(weeklyReset),
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-7d-reset": String(weeklyReset),
    "anthropic-ratelimit-unified-7d-utilization": "0.99",
    "anthropic-ratelimit-unified-7d-status": "rejected",
  }, now);
  assert.deepEqual(info, { retryAfterAt: now / 1000 + 120, resetsAt: weeklyReset, status: "rejected",
    rateLimitType: "seven_day", unifiedWindows: { seven_day: { resetsAt: weeklyReset, utilization: 0.99, status: "rejected" } } });
  assert.deepEqual(readRateLimitHeaders({ "retry-after": new Date(now + 60_000).toUTCString() }, now), { retryAfterAt: now / 1000 + 60 });
  assert.equal(readRateLimitHeaders({ "retry-after": "nonsense", "anthropic-ratelimit-unified-reset": "Infinity",
    "anthropic-ratelimit-unified-status": "secret", "anthropic-ratelimit-unified-representative-claim": "secret" }, now), undefined);
  assert.ok(!JSON.stringify(info).includes("secret"));
});

test("merges header resets with CLI usage without losing window utilization or mutating reports", () => {
  const report: RateLimitInfo = { isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.99 } } };
  const original = structuredClone(report);
  assert.deepEqual(mergeRateLimitInfo(report, { unifiedWindows: { seven_day: { resetsAt: weeklyReset } } }), {
    isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.99, resetsAt: weeklyReset } },
  });
  assert.deepEqual(report, original);
  assert.equal(mergeRateLimitInfo(), undefined);
});

test("uses saved weekly 99% warning, labels it as an estimate, and avoids Pi's generic retries", () => {
  const error = new ClaudeRateLimitError(upstream);
  const reset = findLimitReset(error, saved, now);
  assert.deepEqual(reset, { at: weeklyReset, window: "seven_day", utilization: 0.99, source: "last-reported" });
  const message = describeUsageLimit(error, reset, now);
  assert.match(message, /Last reported weekly reset \(99% used\)/);
  assert.match(message, /2026-10-24T17:00:00.000Z/);
  assert.match(message, /5h 28m/);
  assert.match(message, /estimate/);
  assert.equal(isRetryableAssistantError({ ...assistant({}), stopReason: "error", errorMessage: message }), false);
  // A previous failure with no metadata must not mask the successful usage report.
  assert.deepEqual(findLimitReset(error, [...saved, assistant({ unifiedWindows: {} })], now), reset);
});

test("prefers fresh response metadata and waits for all exhausted windows", () => {
  const at = now / 1000 + 120;
  const response = new ClaudeRateLimitError(upstream, { retryAfterAt: at });
  assert.equal(findLimitReset(response, saved, now)?.at, at);
  const exhausted = new ClaudeRateLimitError(upstream, { unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: at }, seven_day: { status: "rejected", resetsAt: weeklyReset },
  } });
  assert.equal(findLimitReset(exhausted, [], now)?.at, weeklyReset);
});

test("does not guess a reset from low usage, another provider, expired or malformed timestamps", () => {
  const error = new ClaudeRateLimitError(upstream);
  assert.equal(findLimitReset(error, [assistant({ status: "allowed_warning", resetsAt: weeklyReset, utilization: 0.8 })], now), undefined);
  assert.equal(findLimitReset(error, [{ ...saved[0] as AssistantMessage, provider: "other" }], now), undefined);
  for (const resetsAt of [NaN, Infinity, -1, now / 1000 - 1, now / 1000 + 32 * 86400]) {
    assert.equal(findLimitReset(new ClaudeRateLimitError(upstream, { resetsAt }), [], now), undefined);
  }
});

test("auto-resume defaults off and reports the known reset without sleeping", async () => {
  const clock = fakeClock();
  const controller = new UsageLimitController(clock);
  let calls = 0;
  await assert.rejects(controller.run(async () => { calls++; throw new ClaudeRateLimitError(upstream); }, saved), /Auto-resume is off.*claude-code-auto-resume/);
  assert.equal(calls, 1);
  assert.deepEqual(clock.sleeps, []);
});

test("opted-in request sleeps until reset plus grace, retries once, and clears waiting status", async () => {
  const clock = fakeClock();
  const controller = new UsageLimitController(clock);
  controller.setEnabled(true);
  const statuses: Array<string | undefined> = [];
  controller.onWait = (message) => statuses.push(message);
  let calls = 0;
  const result = await controller.run(async () => {
    calls++;
    if (calls === 1) throw new ClaudeRateLimitError(upstream);
    assert.ok(clock.now() >= weeklyReset * 1000 + 1000);
    return "resumed";
  }, saved);
  assert.equal(result, "resumed");
  assert.equal(calls, 2);
  assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 60_000));
  assert.match(statuses[0]!, /Request paused/);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(controller.waiting, undefined);
});

test("unknown resets and repeated rejections stop instead of polling forever", async () => {
  const clock = fakeClock();
  const controller = new UsageLimitController(clock);
  controller.setEnabled(true);
  let calls = 0;
  const request = async () => { calls++; throw new ClaudeRateLimitError(upstream); };
  await assert.rejects(controller.run(request, []), /No future reset time is available/);
  assert.equal(calls, 1);
  assert.equal(clock.sleeps.length, 0);
  calls = 0;
  await assert.rejects(controller.run(request, saved), /Automatic retry was also rejected; stopped/);
  assert.equal(calls, 2);
});

test("abort, disabling auto-resume, and shutdown each cancel a sleeping request without retrying", async () => {
  for (const action of ["abort", "disable", "shutdown"] as const) {
    const controller = new UsageLimitController();
    controller.setEnabled(true);
    const abort = new AbortController();
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    controller.onWait = (message) => { if (message) ready(); };
    let calls = 0;
    const task = controller.run(async () => {
      calls++;
      throw new ClaudeRateLimitError(upstream, { retryAfterAt: Date.now() / 1000 + 3600 });
    }, [], abort.signal);
    const rejected = assert.rejects(task, action === "abort" ? /user cancelled/ : /Automatic resumption cancelled; no retry/);
    await waiting;
    if (action === "abort") abort.abort(new Error("user cancelled"));
    else if (action === "disable") controller.setEnabled(false);
    else controller.cancelPending();
    await rejected;
    assert.equal(calls, 1);
    assert.equal(controller.waiting, undefined);
  }
});

test("shutdown during an in-flight request and disabling at the retry boundary cannot start a retry", async () => {
  for (const boundary of ["in-flight", "after-wait"]) {
    const clock = fakeClock();
    const controller = new UsageLimitController(clock);
    controller.setEnabled(true);
    if (boundary === "after-wait") controller.onWait = (message) => {
      if (!message) controller.setEnabled(false);
    };
    let calls = 0;
    await assert.rejects(controller.run(async () => {
      calls++;
      if (boundary === "in-flight") controller.cancelPending();
      throw new ClaudeRateLimitError(upstream);
    }, saved), /resumption cancelled/);
    assert.equal(calls, 1);
    if (boundary === "in-flight") assert.equal(clock.sleeps.length, 0);
  }
});

test("already-aborted requests never send and unrelated failures are never auto-resumed", async () => {
  const controller = new UsageLimitController(fakeClock());
  controller.setEnabled(true);
  let calls = 0;
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(controller.run(async () => { calls++; }, [], abort.signal), /cancelled/);
  assert.equal(calls, 0);
  const error = new Error("Incomplete Claude Code upstream response (status 200, capture incomplete)");
  await assert.rejects(controller.run(async () => { throw error; }, saved), (caught) => caught === error);
});
