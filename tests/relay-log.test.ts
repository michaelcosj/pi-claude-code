import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRelayLog, transportError } from "../src/relay-log.ts";

test("preserves nested connection errors without payloads or arbitrary messages", () => {
  const inner = Object.assign(new Error("secret payload"), {
    code: "ETIMEDOUT", syscall: "connect", address: "2607:6bc0::10", port: 443,
    headers: { authorization: "secret" }, body: "secret",
  });
  const error = new AggregateError([inner], "secret", { cause: inner });
  const details = transportError(error);
  assert.equal(details.name, "AggregateError");
  assert.deepEqual((details.errors as unknown[])[0], {
    name: "Error", code: "ETIMEDOUT", syscall: "connect", address: "2607:6bc0::10", port: 443,
  });
  assert.ok(!JSON.stringify(details).includes("secret"));
  const circular = new Error("circular", { cause: error });
  circular.cause = circular;
  assert.ok(JSON.stringify(transportError(circular)).includes("truncated"));
});

test("appends private JSONL and ignores unsafe paths and logging failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-relay-log-test-"));
  try {
    const path = join(dir, "relay.jsonl");
    await appendRelayLog({ event: "first" }, path);
    await appendRelayLog({ event: "second" }, path);
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.event), ["first", "second"]);
    assert.equal(records[0].pid, process.pid);
    assert.ok(records[0].timestamp);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const link = join(dir, "link");
    await symlink(path, link);
    await appendRelayLog({ event: "unsafe" }, link);
    assert.ok(!(await readFile(path, "utf8")).includes("unsafe"));
    await appendRelayLog({}, join(dir, "missing", "log"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
