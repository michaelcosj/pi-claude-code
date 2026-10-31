import assert from "node:assert/strict";
import * as http from "node:http";
import type { LookupFunction } from "node:net";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TurnRelay } from "../src/turn-relay.ts";
import { relayLogPath } from "../src/relay-log.ts";

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

const failLookup: LookupFunction = (_hostname, _options, callback) => {
  process.nextTick(() => callback(Object.assign(new AggregateError([
    Object.assign(new Error("private-error-text"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("private-error-text"), { code: "ENETUNREACH" }),
  ]), { code: "ETIMEDOUT" }), ""));
};

async function recordFor(port: number) {
  const raw = await readFile(relayLogPath, "utf8");
  const record = raw.trim().split("\n").map((line) => JSON.parse(line))
    .findLast((item) => item.upstream === `http://127.0.0.1:${port}`);
  assert.ok(record);
  assert.ok(!raw.includes("private-error-text"));
  assert.ok(!raw.includes("private-retry-conversation"));
  return record;
}

test("relay pre-connect retries transform once, deliver one generation, retain the native recovery guard, and reset next turn", async (t) => {
  const bodies: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    // Force a fresh connection next turn so its independent retry budget is exercised too.
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    res.end([
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const port = await listen(upstream);
  const createConnection = http.globalAgent.createConnection.bind(http.globalAgent);
  let attempts = 0;
  t.mock.method(http.globalAgent, "createConnection", (options: http.ClientRequestArgs, callback: Parameters<typeof createConnection>[1]) => {
    if (Number(options.port) === port && ++attempts % 3 !== 0) {
      return createConnection({ ...options, host: "fixture.invalid", lookup: failLookup }, callback);
    }
    return createConnection(options, callback);
  });
  let transforms = 0;
  const transform = (body: Buffer) => {
    transforms += 1;
    return Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), replacedByPayloadHook: true }));
  };
  const events: string[] = [];
  const relay = new TurnRelay(`http://127.0.0.1:${port}`, 10_000, (event) => events.push(event.type), transform);
  try {
    const url = `${await relay.start()}/v1/messages`;
    for (let turn = 1; turn <= 2; turn += 1) {
      if (turn === 2) {
        relay.finishTurn();
        relay.beginTurn((event) => events.push(event.type), transform);
      }
      const response = await fetch(url, { method: "POST", body: '{"prompt":"private-retry-conversation"}' });
      assert.equal(response.status, 200);
      await response.text();
      await relay.settled();
      assert.equal(relay.failure, undefined);
      assert.equal(relay.capture.complete, true);
      assert.equal(attempts, turn * 3);
      assert.equal(transforms, turn, "payload hooks run once per logical request, not per connection attempt");
      assert.equal(bodies.length, turn, "only one generation can reach the upstream each turn");
      assert.equal(events.filter((event) => event === "message_stop").length, turn);
      const record = await recordFor(port);
      assert.equal(record.connectionAttempts, 3);
      assert.equal(record.error, undefined);
      assert.equal(record.network.filter((entry: { event: string }) => entry.event === "retry").length, 2);
      const duplicate = await fetch(url, { method: "POST", body: "{}" });
      assert.equal(duplicate.status, 400);
      await duplicate.text();
      assert.equal(attempts, turn * 3, "native recovery cannot start another upstream request");
    }
    assert.deepEqual(JSON.parse(bodies[0]!), { prompt: "private-retry-conversation", replacedByPayloadHook: true });
    assert.equal(bodies[0], bodies[1]);
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("abort, shutdown, and client disconnect each cancel relay backoff without another attempt", async (t) => {
  for (const mode of ["abort", "close", "disconnect"] as const) {
    await t.test(mode, async (t) => {
      const upstream = http.createServer((_req, res) => res.end("must not be reached"));
      const port = await listen(upstream);
      const relay = new TurnRelay(`http://127.0.0.1:${port}`, 10_000);
      let closed: Promise<void> | undefined;
      let local: http.ClientRequest;
      let attempts = 0;
      const createConnection = http.globalAgent.createConnection.bind(http.globalAgent);
      t.mock.method(http.globalAgent, "createConnection", (options: http.ClientRequestArgs, callback: Parameters<typeof createConnection>[1]) => {
        if (Number(options.port) !== port) return createConnection(options, callback);
        attempts += 1;
        setImmediate(() => {
          if (mode === "abort") relay.abort();
          if (mode === "close") closed = relay.close();
          if (mode === "disconnect") local.destroy();
        });
        return createConnection({ ...options, host: "fixture.invalid", lookup: failLookup }, callback);
      });
      try {
        const url = `${await relay.start()}/v1/messages`;
        await new Promise<void>((resolve) => {
          local = http.request(url, { method: "POST" });
          local.on("error", () => resolve());
          local.on("response", (response) => { response.resume(); response.on("end", resolve); });
          local.end("{}");
        });
        await closed;
        await relay.settled();
        assert.equal(attempts, 1);
        const record = await recordFor(port);
        assert.equal(record.connectionAttempts, 1);
        assert.equal(record.cancelled, true);
        assert.ok(record.network.some((entry: { event: string }) => entry.event === "retry"), "cancelled during backoff");
      } finally {
        await relay.close();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    });
  }
});
