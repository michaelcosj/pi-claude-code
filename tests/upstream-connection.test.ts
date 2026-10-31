import assert from "node:assert/strict";
import * as http from "node:http";
import type { LookupFunction } from "node:net";
import test, { type TestContext } from "node:test";
import { connectUpstream, isTransientConnectError } from "../src/upstream-connection.ts";

const errorWithCode = (code: string) => Object.assign(new Error("must not leak arbitrary error text"), { code });
const aggregate = () => Object.assign(new AggregateError([
  errorWithCode("ETIMEDOUT"), errorWithCode("ENETUNREACH"),
]), { code: "ETIMEDOUT" });

type NetworkEvent = { event: string; attempt: number; [key: string]: unknown };
const noteTo = (events: NetworkEvent[]) => (event: string, details: Record<string, unknown>) => {
  events.push({ event, ...details } as NetworkEvent);
};

async function fixture(t: TestContext, handler: http.RequestListener = (_req, res) => res.end("ok")) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { protocol: "http:", hostname: "fixture.invalid", port: address.port, method: "POST", timeout: 10_000, agent: false as const };
}

function lookupAfterFailures(failures: number, error: Error) {
  let calls = 0;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    calls += 1;
    process.nextTick(() => calls <= failures
      ? callback(error, "")
      : callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4));
  };
  return { lookup, calls: () => calls };
}

async function consume(response: http.IncomingMessage) {
  let body = "";
  for await (const chunk of response) body += chunk;
  return body;
}

test("only known transient connect errors (including every AggregateError leaf) qualify", () => {
  for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"]) {
    assert.equal(isTransientConnectError(errorWithCode(code)), true, code);
  }
  assert.equal(isTransientConnectError(aggregate()), true);
  assert.equal(isTransientConnectError(new Error("wrapper", { cause: aggregate() })), true);
  for (const error of [
    errorWithCode("ENOTFOUND"), errorWithCode("CERT_HAS_EXPIRED"), errorWithCode("ABORT_ERR"),
    new Error("ETIMEDOUT"), new AggregateError([]),
    Object.assign(new AggregateError([errorWithCode("ETIMEDOUT"), errorWithCode("CERT_HAS_EXPIRED")]), { code: "ETIMEDOUT" }),
  ]) assert.equal(isTransientConnectError(error), false);
  const circular: { cause?: unknown } = {};
  circular.cause = circular;
  assert.equal(isTransientConnectError(circular), false);
});

test("retries the observed IPv4 timeout/IPv6 no-route AggregateError twice, sends the same body once, and applies the 2s timeout", async (t) => {
  const bodies: string[] = [];
  const options = await fixture(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    res.end("ok");
  });
  const dns = lookupAfterFailures(2, aggregate());
  const agent = new http.Agent({ keepAlive: false });
  t.after(() => agent.destroy());
  const createConnection = agent.createConnection.bind(agent);
  const connectionOptions: Record<string, unknown>[] = [];
  agent.createConnection = (options, callback) => {
    connectionOptions.push(options as unknown as Record<string, unknown>);
    return createConnection(options, callback);
  };
  const events: NetworkEvent[] = [];
  const response = await connectUpstream({ ...options, agent, lookup: dns.lookup }, Buffer.from("private-conversation"), {
    signal: new AbortController().signal, onNetwork: noteTo(events),
  });
  assert.equal(await consume(response), "ok");
  assert.equal(dns.calls(), 3);
  assert.deepEqual(bodies, ["private-conversation"]);
  assert.deepEqual(events.filter((e) => e.event === "requestAttempt").map((e) => e.attempt), [1, 2, 3]);
  assert.deepEqual(events.filter((e) => e.event === "requestAttemptFailed").map((e) => e.connected), [false, false]);
  for (const options of connectionOptions) {
    assert.equal(options.autoSelectFamily, true);
    assert.equal(options.autoSelectFamilyAttemptTimeout, 2_000);
  }
  const retries = events.filter((e) => e.event === "retry");
  assert.ok(Number(retries[0]!.delayMs) >= 500 && Number(retries[0]!.delayMs) <= 750);
  assert.ok(Number(retries[1]!.delayMs) >= 1_000 && Number(retries[1]!.delayMs) <= 1_250);
  assert.ok(!JSON.stringify(events).includes("private-conversation"));
  assert.ok(!JSON.stringify(events).includes("must not leak"));
});

test("persistent connection failures stop after three attempts", async (t) => {
  const options = await fixture(t);
  const dns = lookupAfterFailures(Infinity, aggregate());
  const events: NetworkEvent[] = [];
  await assert.rejects(connectUpstream({ ...options, lookup: dns.lookup }, Buffer.from("{}"), {
    signal: new AbortController().signal, onNetwork: noteTo(events),
  }), { code: "ETIMEDOUT" });
  assert.equal(dns.calls(), 3);
  assert.equal(events.filter((e) => e.event === "retry").length, 2);
});

test("a nontransient DNS failure does not retry", async (t) => {
  const options = await fixture(t);
  const dns = lookupAfterFailures(Infinity, errorWithCode("ENOTFOUND"));
  await assert.rejects(connectUpstream({ ...options, lookup: dns.lookup }, Buffer.from("{}"), {
    signal: new AbortController().signal,
  }), { code: "ENOTFOUND" });
  assert.equal(dns.calls(), 1);
});

test("abort during retry backoff does not start another attempt", async (t) => {
  const options = await fixture(t);
  const dns = lookupAfterFailures(Infinity, aggregate());
  const controller = new AbortController();
  await assert.rejects(connectUpstream({ ...options, lookup: dns.lookup }, Buffer.from("{}"), {
    signal: controller.signal,
    onNetwork: (event) => { if (event === "retry") setImmediate(() => controller.abort()); },
  }), { name: "AbortError" });
  assert.equal(dns.calls(), 1);
});

test("already-aborted requests never start, and abort during DNS stops immediately", async (t) => {
  const options = await fixture(t);
  const before = new AbortController();
  before.abort();
  let requests = 0;
  await assert.rejects(connectUpstream(options, Buffer.from("{}"), {
    signal: before.signal, onRequest: () => { requests += 1; },
  }), { name: "AbortError" });
  assert.equal(requests, 0);
  const during = new AbortController();
  const lookup: LookupFunction = () => { setImmediate(() => during.abort()); };
  await assert.rejects(connectUpstream({ ...options, lookup }, Buffer.from("{}"), {
    signal: during.signal, onRequest: () => { requests += 1; },
  }), { name: "AbortError" });
  assert.equal(requests, 1);
});

test("the original header deadline bounds stalled DNS and prevents extra backoff/retries", async (t) => {
  const options = await fixture(t);
  const events: NetworkEvent[] = [];
  const lookup: LookupFunction = () => {}; // No DNS callback: socket inactivity cannot catch this.
  await assert.rejects(connectUpstream({ ...options, lookup, timeout: 50 }, Buffer.from("{}"), {
    signal: new AbortController().signal, onNetwork: noteTo(events),
  }), { code: "ETIMEDOUT" });
  assert.equal(events.filter((e) => e.event === "requestAttempt").length, 1);
  assert.equal(events.filter((e) => e.event === "retry").length, 0);
});

test("a reset after TCP connect but before response headers is not safe to retry", async (t) => {
  let received = 0;
  const options = await fixture(t, (req) => { received += 1; req.socket.destroy(); });
  const dns = lookupAfterFailures(0, aggregate());
  const events: NetworkEvent[] = [];
  await assert.rejects(connectUpstream({ ...options, lookup: dns.lookup }, Buffer.from("{}"), {
    signal: new AbortController().signal, onNetwork: noteTo(events),
  }), { code: "ECONNRESET" });
  assert.equal(received, 1);
  assert.equal(events.find((e) => e.event === "requestAttemptFailed")!.connected, true);
  assert.equal(events.filter((e) => e.event === "retry").length, 0);
});

test("a reset on a reused keep-alive socket does not replay the request", async (t) => {
  let received = 0;
  const options = await fixture(t, (req, res) => {
    received += 1;
    if (received === 1) { req.resume(); res.end("ok"); }
    else req.socket.destroy();
  });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const dns = lookupAfterFailures(0, aggregate());
  const events: NetworkEvent[] = [];
  const callbacks = { signal: new AbortController().signal, onNetwork: noteTo(events) };
  const requestOptions = { ...options, agent, lookup: dns.lookup };
  assert.equal(await consume(await connectUpstream(requestOptions, Buffer.from("{}"), callbacks)), "ok");
  events.length = 0;
  await assert.rejects(connectUpstream(requestOptions, Buffer.from("{}"), callbacks), { code: "ECONNRESET" });
  assert.equal(received, 2);
  assert.equal(events.find((e) => e.event === "socket")!.reused, true);
  assert.equal(events.filter((e) => e.event === "retry").length, 0);
});

test("HTTP errors and partial response bodies are returned without replay", async (t) => {
  for (const status of [401, 429, 500, 503, 200]) {
    let received = 0;
    const options = await fixture(t, (req, res) => {
      received += 1;
      req.resume();
      res.writeHead(status);
      if (status !== 200) res.end("upstream error");
      else { res.write("partial stream"); setImmediate(() => res.destroy()); }
    });
    const dns = lookupAfterFailures(0, aggregate());
    const events: NetworkEvent[] = [];
    const response = await connectUpstream({ ...options, lookup: dns.lookup }, Buffer.from("{}"), {
      signal: new AbortController().signal, onNetwork: noteTo(events),
    });
    assert.equal(response.statusCode, status);
    if (status === 200) await assert.rejects(consume(response));
    else assert.equal(await consume(response), "upstream error");
    assert.equal(received, 1);
    assert.equal(events.filter((e) => e.event === "retry").length, 0);
  }
});
