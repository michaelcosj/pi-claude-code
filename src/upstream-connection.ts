import * as http from "node:http";
import * as https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import type { TcpSocketConnectOpts } from "node:net";
import { transportError } from "./relay-log.ts";

const ADDRESS_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const TRANSIENT_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN",
]);

/** Every leaf of an AggregateError must be transient; certificates/configuration errors never qualify. */
export function isTransientConnectError(error: unknown, depth = 0): boolean {
  if (depth >= 6 || !error || typeof error !== "object") return false;
  const source = error as { code?: unknown; errors?: unknown; cause?: unknown };
  if (Array.isArray(source.errors)) {
    return source.errors.length > 0 && source.errors.length <= 16 &&
      source.errors.every((child) => isTransientConnectError(child, depth + 1));
  }
  if (source.code !== undefined && (typeof source.code !== "string" || !TRANSIENT_CODES.has(source.code))) return false;
  if (source.cause !== undefined) return isTransientConnectError(source.cause, depth + 1);
  return typeof source.code === "string" && TRANSIENT_CODES.has(source.code);
}

interface ConnectionCallbacks {
  signal: AbortSignal;
  onRequest?: (request: http.ClientRequest) => void;
  onNetwork?: (event: string, details: Record<string, unknown>) => void;
}

function timeoutError(): Error {
  return Object.assign(new Error("Claude Code upstream deadline exceeded"), { code: "ETIMEDOUT" });
}

/**
 * Retry only before TCP connect. Once connected (including a reused socket), the upstream may
 * have received the POST even without response headers, so automatically replaying is unsafe.
 * The caller consumes the one returned response; no HTTP status or partial stream is retried here.
 */
export async function connectUpstream(
  options: http.RequestOptions,
  body: Buffer,
  { signal, onRequest, onNetwork }: ConnectionCallbacks,
): Promise<http.IncomingMessage> {
  const deadline = performance.now() + (options.timeout ?? 180_000);
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw timeoutError();
    const note = (event: string, details: Record<string, unknown> = {}) => onNetwork?.(event, { attempt, ...details });
    note("requestAttempt", { addressTimeoutMs: ADDRESS_TIMEOUT_MS });
    let request: http.ClientRequest | undefined;
    let connected = false;
    let receivedResponse = false;
    let failure: unknown;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup: (() => void)[] = [];
    try {
      return await new Promise<http.IncomingMessage>((resolve, reject) => {
        const transport = options.protocol === "https:" ? https : http;
        const connectionOptions: http.RequestOptions & Pick<TcpSocketConnectOpts, "autoSelectFamily" | "autoSelectFamilyAttemptTimeout"> = {
          ...options,
          signal,
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: ADDRESS_TIMEOUT_MS,
          timeout: remaining,
        };
        const req = request = transport.request(connectionOptions);
        req.once("error", reject);
        req.once("response", (response) => {
          receivedResponse = true;
          resolve(response);
        });
        // Socket inactivity alone does not bound DNS or the last address's connection attempt.
        connectTimer = setTimeout(() => {
          note("connectDeadline");
          req.destroy(timeoutError());
        }, Math.min(CONNECT_TIMEOUT_MS, remaining));
        deadlineTimer = setTimeout(() => req.destroy(timeoutError()), remaining);
        const onTimeout = () => req.destroy(timeoutError());
        req.once("timeout", onTimeout);
        req.once("close", () => req.off("timeout", onTimeout));
        req.once("socket", (socket) => {
          // A keep-alive socket has already connected, even though no new connect event fires.
          connected = req.reusedSocket || !socket.connecting;
          if (connected) clearTimeout(connectTimer);
          note("socket", { reused: req.reusedSocket });
          const listen = (event: string, listener: (...args: any[]) => void) => {
            socket.on(event, listener);
            cleanup.push(() => socket.off(event, listener));
          };
          listen("lookup", (error, address, family) => note("lookup", { address, family, error: error ? transportError(error) : undefined }));
          listen("connectionAttempt", (address, port, family) => note("connectionAttempt", { address, port, family }));
          listen("connectionAttemptFailed", (address, port, family, error) =>
            note("connectionAttemptFailed", { address, port, family, error: transportError(error) }));
          listen("connectionAttemptTimeout", (address, port, family) => note("connectionAttemptTimeout", { address, port, family }));
          listen("connect", () => {
            connected = true;
            clearTimeout(connectTimer);
            note("connect", { address: socket.remoteAddress, port: socket.remotePort });
          });
          listen("secureConnect", () => note("secureConnect"));
          listen("timeout", () => note("socketTimeout"));
        });
        onRequest?.(req);
        req.end(body);
      });
    } catch (error) {
      failure = error;
      note("requestAttemptFailed", { connected, error: transportError(error) });
      if (signal.aborted || connected || attempt >= MAX_ATTEMPTS || !isTransientConnectError(error)) throw error;
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(deadlineTimer);
      for (const remove of cleanup) remove();
      if (!receivedResponse) request?.destroy();
    }
    // 500–750 ms then 1000–1250 ms. Don't extend the original request's header deadline.
    const delayMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 251);
    if (performance.now() + delayMs >= deadline) throw failure;
    note("retry", { delayMs, nextAttempt: attempt + 1 });
    await sleep(delayMs, undefined, { signal });
  }
}
