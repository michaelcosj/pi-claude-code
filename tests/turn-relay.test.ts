import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { relayLogPath } from "../src/relay-log.ts";
import { describeFailure, TurnRelay } from "../src/turn-relay.ts";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      resolve(address.port);
    });
  });
}

test("relays one upstream Messages request and captures its SSE response", async () => {
  const upstreamBodies: string[] = [];
  const upstreamBetas: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    upstreamBodies.push(body);
    upstreamBetas.push(String(request.headers["anthropic-beta"] ?? ""));
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test",
      ...(upstreamBodies.length === 1 ? { "retry-after": "120" } : {}) });
    const usage = {
      input_tokens: 2,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const events = [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const upstreamPort = await listen(upstream);
  const observed: string[] = [];
  const relay = new TurnRelay(
    `http://127.0.0.1:${upstreamPort}`,
    5_000,
    (event) => observed.push(event.type),
    (body) => Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8")), rewritten: true })),
    ["native-tools-test"],
  );

  try {
    const baseUrl = await relay.start();
    const first = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-beta": "existing-test" },
      body: "{}",
    });
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(second.status, 400);
    await relay.settled();

    assert.equal(upstreamBodies.length, 1);
    assert.deepEqual(JSON.parse(upstreamBodies[0]!), { rewritten: true });
    assert.deepEqual(JSON.parse(relay.originalRequestBody!.toString("utf8")), {});
    assert.equal(upstreamBetas[0], "existing-test,native-tools-test");
    assert.equal(relay.used, true);
    assert.equal(relay.denied, 1);
    assert.equal(relay.capture.complete, true);
    assert.equal(relay.capture.message?.content[0]?.type, "text");
    assert.equal((relay.capture.message?.content[0] as { text: string }).text, "hello");
    assert.equal(relay.requestId, "req_test");
    assert.equal(typeof relay.rateLimit?.retryAfterAt, "number");
    assert.deepEqual(observed.at(-1), "message_stop");

    relay.finishTurn();
    const nextObserved: string[] = [];
    relay.beginTurn((event) => nextObserved.push(event.type));
    assert.equal(relay.rateLimit, undefined);
    const next = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: '{"turn":2}' });
    assert.equal(next.status, 200);
    await next.text();
    await relay.settled();
    assert.equal(upstreamBodies.length, 2);
    assert.deepEqual(JSON.parse(upstreamBodies[1]!), { turn: 2 });
    assert.equal(relay.denied, 0);
    assert.equal(relay.capture.complete, true);
    assert.equal(nextObserved.at(-1), "message_stop");
    const records = (await readFile(relayLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const record = records.findLast((item) => item.upstream === `http://127.0.0.1:${upstreamPort}`);
    assert.equal(record.cache.comparison, "no-baseline");
    assert.equal(record.cache.usage.input, 2);
    assert.equal(record.cache.usage.output, 1);
    assert.equal(record.cache.usage.readShare, 0);
    assert.equal(record.continuation, false);
    assert.equal(typeof record.worker, "string");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("logs a failed upstream connection without request credentials or body", async () => {
  const closed = http.createServer();
  const port = await listen(closed);
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const relay = new TurnRelay(`http://127.0.0.1:${port}`, 1_000);
  try {
    const baseUrl = await relay.start();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer private-token" },
      body: "private-conversation",
    });
    assert.equal(response.status, 502);
    await response.text();
    await relay.settled();
    assert.ok(relay.failure?.includes("ECONNREFUSED"));
    const raw = await readFile(relayLogPath, "utf8");
    assert.ok(!raw.includes("private-token"));
    assert.ok(!raw.includes("private-conversation"));
    const record = raw.trim().split("\n").map((line) => JSON.parse(line))
      .findLast((item) => item.upstream === `http://127.0.0.1:${port}`);
    assert.equal(record.error.code, "ECONNREFUSED");
    assert.equal(record.error.port, port);
    assert.equal(record.captureComplete, false);
    assert.ok(record.network.some((item: { event: string }) => item.event === "socket"));
  } finally {
    await relay.close();
  }
});

test("surfaces an error event from an otherwise successful SSE stream", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const usage = { input_tokens: 2, output_tokens: 0 };
    response.end(
      [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } })}\n\n`,
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
      ].join(""),
    );
  });
  const upstreamPort = await listen(upstream);
  const relay = new TurnRelay(`http://127.0.0.1:${upstreamPort}`, 5_000);

  try {
    const baseUrl = await relay.start();
    const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    await response.text();
    await relay.settled();

    assert.equal(relay.capture.complete, false);
    assert.equal(relay.errorText(), "overloaded_error: Overloaded");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("describes relay failures with their error code and nested errors", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  assert.equal(describeFailure(refused), "Error: connect ECONNREFUSED 127.0.0.1:1");
  const timeout = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { code: "ETIMEDOUT" });
  const every = Object.assign(new AggregateError([refused, timeout]), { code: "ETIMEDOUT" });
  assert.equal(
    describeFailure(every),
    "AggregateError (ETIMEDOUT) [Error: connect ECONNREFUSED 127.0.0.1:1; Error: connect ETIMEDOUT 10.0.0.1:443]",
  );
  assert.equal(describeFailure(Object.assign(new Error(""), { code: "ECONNRESET" })), "Error (ECONNRESET)");
  assert.equal(describeFailure("nope"), "UnknownError");
});
