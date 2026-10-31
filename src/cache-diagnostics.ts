import { createHmac, randomBytes } from "node:crypto";
import type { NativeUsage } from "./native-types.ts";

// Process-local keyed hashes allow comparisons without exposing guessable prompt hashes.
const key = randomBytes(32);
const baselines = new Map<string, Snapshot>();
const MAX_SESSIONS = 32;
const FIELDS = ["model", "tools", "system", "thinking", "output_config", "tool_choice", "context_management", "speed"] as const;

function hash(value: unknown): string {
  return createHmac("sha256", key).update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function withoutMarker(value: unknown): unknown {
  const block = object(value);
  if (!block) return value;
  const { cache_control: _marker, ...rest } = block;
  return rest;
}

interface Block {
  path: string;
  hash: string;
  prefixHash: string;
  breakpoint?: { ttl: "1h" | "5m" | "unknown" };
}

interface Snapshot {
  turn: string;
  started: number;
  fields: Record<string, string>;
  blocks: Block[];
}

/** Only fingerprints and structural locations leave this function, never request content. */
export function cacheDiagnostics(body: Buffer, sessionId?: string, started = Date.now()) {
  const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  const session = sessionId ? hash(sessionId) : undefined;
  const previous = session ? baselines.get(session) : undefined;
  const fields = Object.fromEntries(FIELDS.map((name) => {
    const value = payload[name];
    return [name, hash(Array.isArray(value) ? value.map(withoutMarker) : withoutMarker(value))];
  }));
  const blocks: Block[] = [];
  // These fields affect the prompt before its tools/system/messages hierarchy.
  let prefix = hash(FIELDS.filter((name) => name !== "tools" && name !== "system").map((name) => fields[name]));
  const add = (path: string, value: unknown, envelope?: unknown) => {
    const blockHash = hash([envelope, withoutMarker(value)]);
    prefix = hash([prefix, blockHash]);
    const marker = object(object(value)?.cache_control);
    blocks.push({
      path,
      hash: blockHash,
      prefixHash: prefix,
      ...(marker ? { breakpoint: { ttl: marker.ttl === "1h" ? "1h" as const : marker.ttl === undefined || marker.ttl === "5m" ? "5m" as const : "unknown" as const } } : {}),
    });
  };
  for (const name of ["tools", "system"] as const) {
    const value = payload[name];
    if (Array.isArray(value)) value.forEach((block, index) => add(`${name}[${index}]`, block));
    else if (value !== undefined) add(name, value);
  }
  if (Array.isArray(payload.messages)) payload.messages.forEach((value, index) => {
    const message = object(value);
    const { content, ...envelope } = message ?? {};
    if (Array.isArray(content)) content.forEach((block, blockIndex) => add(`messages[${index}].content[${blockIndex}]`, block, envelope));
    else add(`messages[${index}].content`, content, envelope);
  });
  const snapshot: Snapshot = { turn: randomBytes(8).toString("hex"), started, fields, blocks };
  let matched = 0;
  if (previous) while (matched < Math.min(previous.blocks.length, blocks.length) && previous.blocks[matched]!.hash === blocks[matched]!.hash) matched++;
  const changedFields = previous ? FIELDS.filter((name) => previous.fields[name] !== fields[name]) : [];
  const prefixChanged = changedFields.length > 0 || (previous && matched < previous.blocks.length);
  const firstDifference = previous && matched < Math.max(previous.blocks.length, blocks.length) ? {
    previousPath: previous.blocks[matched]?.path,
    currentPath: blocks[matched]?.path,
    previousHash: previous.blocks[matched]?.hash,
    currentHash: blocks[matched]?.hash,
  } : undefined;
  const prefixes = new Map(blocks.map((block) => [block.prefixHash, block.path]));
  const request = {
    session,
    turn: snapshot.turn,
    previousTurn: previous?.turn,
    sincePreviousStartMs: previous ? started - previous.started : undefined,
    comparison: !previous ? "no-baseline" : prefixChanged ? "prefix-changed" : blocks.length > previous.blocks.length ? "append-only" : "unchanged",
    changedFields,
    matchedBlocks: previous ? matched : undefined,
    previousBlocks: previous?.blocks.length,
    blocks: blocks.length,
    firstDifference,
    fields,
    breakpoints: blocks.filter((block) => block.breakpoint).map((block) => ({ path: block.path, ...block.breakpoint, prefixHash: block.prefixHash })),
    previousBreakpoints: previous?.blocks.filter((block) => block.breakpoint).map((block) => ({
      previousPath: block.path,
      currentPath: prefixes.get(block.prefixHash) ?? null,
      ...block.breakpoint,
    })),
  };
  return {
    request,
    finish(usage: NativeUsage | undefined, successful: boolean) {
      if (successful && session && (baselines.get(session)?.started ?? -Infinity) <= started) {
        // Keep the latest successful request even when concurrent requests finish out of order.
        // Failed or incomplete responses are not evidence that a cache entry was written.
        baselines.delete(session);
        baselines.set(session, snapshot);
        if (baselines.size > MAX_SESSIONS) baselines.delete(baselines.keys().next().value!);
      }
      const input = usage?.input_tokens ?? 0;
      const read = usage?.cache_read_input_tokens ?? 0;
      const write = usage?.cache_creation_input_tokens ?? 0;
      const total = input + read + write;
      const oneHour = usage?.cache_creation?.ephemeral_1h_input_tokens;
      const fiveMinute = usage?.cache_creation?.ephemeral_5m_input_tokens;
      return {
        ...request,
        usage: usage ? {
          input, cacheRead: read, cacheWrite: write, output: usage.output_tokens,
          cacheWrite1h: typeof oneHour === "number" ? oneHour : undefined,
          cacheWrite5m: typeof fiveMinute === "number" ? fiveMinute : undefined,
          readShare: total ? read / total : undefined,
        } : undefined,
      };
    },
  };
}
