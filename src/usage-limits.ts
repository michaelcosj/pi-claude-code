import type { Message } from "@earendil-works/pi-ai";
import type { RateLimitInfo } from "./billing.ts";

export const AUTO_RESUME_ENTRY = "claude-code.auto-resume";
export const AUTO_RESUME_COMMAND = "/claude-code-auto-resume";

const WINDOW_NAMES: Record<string, string> = {
  five_hour: "five-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet",
};

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 8.64e12 ? value : undefined;
}

/** Extract only typed, allowlisted limit metadata. Never retain arbitrary headers. */
export function readRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
  now = Date.now(),
): RateLimitInfo | undefined {
  const info: RateLimitInfo = {};
  const scalar = (name: string) => typeof headers[name] === "string" ? headers[name] as string : undefined;
  const number = (name: string) => {
    const value = scalar(name);
    return value?.trim() ? Number(value) : NaN;
  };
  const status = (name: string) => {
    const value = scalar(name);
    return value && ["allowed", "allowed_warning", "rejected"].includes(value) ? value : undefined;
  };
  const retry = scalar("retry-after");
  if (retry) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
    const at = Number.isFinite(seconds) ? now / 1000 + seconds :
      /^[-+\d]/.test(retry.trim()) ? NaN : Date.parse(retry) / 1000;
    if (timestamp(at)) info.retryAfterAt = at;
  }
  const prefix = "anthropic-ratelimit-unified";
  const reset = timestamp(number(`${prefix}-reset`));
  if (reset) info.resetsAt = reset;
  const overallStatus = status(`${prefix}-status`);
  if (overallStatus) info.status = overallStatus;
  const claim = scalar(`${prefix}-representative-claim`);
  if (claim && Object.hasOwn(WINDOW_NAMES, claim)) info.rateLimitType = claim;
  for (const [suffix, type] of [["5h", "five_hour"], ["7d", "seven_day"], ["7d-opus", "seven_day_opus"], ["7d-sonnet", "seven_day_sonnet"]] as const) {
    const resetsAt = timestamp(number(`${prefix}-${suffix}-reset`));
    const utilization = number(`${prefix}-${suffix}-utilization`);
    const windowStatus = status(`${prefix}-${suffix}-status`);
    const validUtilization = Number.isFinite(utilization) && utilization >= 0;
    if (!resetsAt && !validUtilization && !windowStatus) continue;
    const window: NonNullable<RateLimitInfo["unifiedWindows"]>[string] = {};
    if (resetsAt) window.resetsAt = resetsAt;
    if (validUtilization) window.utilization = utilization;
    if (windowStatus) window.status = windowStatus;
    (info.unifiedWindows ??= {})[type] = window;
  }
  return Object.keys(info).length ? info : undefined;
}

export function mergeRateLimitInfo(report?: RateLimitInfo, headers?: RateLimitInfo): RateLimitInfo | undefined {
  if (!report && !headers) return undefined;
  const info = { ...report, ...headers };
  if (report?.unifiedWindows || headers?.unifiedWindows) {
    info.unifiedWindows = { ...report?.unifiedWindows };
    for (const [name, window] of Object.entries(headers?.unifiedWindows ?? {})) {
      info.unifiedWindows[name] = { ...info.unifiedWindows[name], ...window };
    }
  }
  return info;
}

/** A rejected HTTP request, never a partially generated or executed assistant turn. */
export class ClaudeRateLimitError extends Error {
  constructor(readonly upstreamMessage: string, readonly rateLimit?: RateLimitInfo) {
    super(upstreamMessage);
    this.name = "ClaudeRateLimitError";
  }
}

export interface LimitReset {
  at: number; // epoch seconds
  window?: string;
  utilization?: number;
  source: "response" | "last-reported";
}

function latestLimit(messages: Message[]): RateLimitInfo | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.provider !== "claude-code") continue;
    const diagnostic = message.diagnostics?.findLast((item) => item.type === "claude-code.rate-limit");
    const details = diagnostic?.details;
    if (details && typeof details === "object") {
      const info = details as RateLimitInfo;
      // An error without reset metadata must not hide the preceding usage report.
      if (timestamp(info.resetsAt) || timestamp(info.retryAfterAt) ||
          Object.values(info.unifiedWindows ?? {}).some((window) => timestamp(window?.resetsAt))) return info;
    }
  }
  return undefined;
}

function resetFromInfo(info: RateLimitInfo | undefined, now: number, source: LimitReset["source"]): LimitReset | undefined {
  if (!info) return undefined;
  const candidates: LimitReset[] = [];
  const add = (at: unknown, window?: string, utilization?: number) => {
    const valid = timestamp(at);
    if (valid && valid * 1000 > now && valid * 1000 - now <= 31 * 24 * 60 * 60 * 1000) {
      candidates.push({ at: valid, window, utilization, source });
    }
  };
  const windows = info.unifiedWindows;
  const primary = info.rateLimitType ? windows?.[info.rateLimitType] : undefined;
  if (source === "response" || info.status === "rejected" || (info.utilization ?? primary?.utilization ?? 0) >= 0.99) {
    add(info.resetsAt, info.rateLimitType, info.utilization ?? primary?.utilization);
  }
  if (windows && typeof windows === "object") {
    for (const [name, window] of Object.entries(windows)) {
      if (window && (window.status === "rejected" || (window.utilization ?? 0) >= 0.99)) {
        add(window.resetsAt, name, window.utilization);
      }
    }
  }
  if (source === "response") add(info.retryAfterAt);
  // If more than one window is exhausted, all must recover before retrying.
  return candidates.sort((a, b) => b.at - a.at)[0];
}

export function findLimitReset(error: ClaudeRateLimitError, messages: Message[], now = Date.now()): LimitReset | undefined {
  return resetFromInfo(error.rateLimit, now, "response") ?? resetFromInfo(latestLimit(messages), now, "last-reported");
}

export function describeUsageLimit(error: ClaudeRateLimitError, reset: LimitReset | undefined, now = Date.now()): string {
  // Pi classifies "billing" as an account error, preventing its short generic
  // retry loop from repeatedly resending a request blocked for hours or days.
  let message = "Claude Code billing/usage limit (HTTP 429): Anthropic rejected this request.";
  if (reset) {
    const label = reset.window && Object.hasOwn(WINDOW_NAMES, reset.window) ? WINDOW_NAMES[reset.window] : "usage";
    const utilization = typeof reset.utilization === "number" && Number.isFinite(reset.utilization)
      ? ` (${Math.round(reset.utilization * 100)}% used)` : "";
    const local = new Date(reset.at * 1000).toLocaleString(undefined, { timeZoneName: "short" });
    const minutes = Math.max(1, Math.ceil((reset.at * 1000 - now) / 60_000));
    const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    message += ` ${reset.source === "last-reported" ? "Last reported" : "Reported"} ${label} reset${utilization}: ${local} (${new Date(reset.at * 1000).toISOString()}, about ${duration}).`;
    if (reset.source === "last-reported") message += " This is an estimate from the latest saved usage report, not a guarantee.";
  } else {
    message += " No future reset time is available; Pi will not guess or wait indefinitely. Check claude.ai/settings/usage.";
  }
  return message + ` Upstream: ${error.upstreamMessage.slice(0, 500)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** One controller per extension runtime. No timers start until an opted-in request is rejected. */
export class UsageLimitController {
  private autoResume = false;
  onWait?: (message: string | undefined) => void;
  private cancellation = new AbortController();
  private readonly pending = new Map<symbol, string>();

  constructor(private readonly clock: Clock = { now: Date.now, sleep }) {}

  get enabled(): boolean { return this.autoResume; }
  get waiting(): string | undefined { return this.pending.values().next().value; }

  setEnabled(enabled: boolean): void {
    this.autoResume = enabled;
    if (!enabled) this.cancelPending();
  }

  cancelPending(): void {
    this.cancellation.abort(new Error("Automatic resumption cancelled"));
    this.cancellation = new AbortController();
  }

  private report(): void {
    try { this.onWait?.(this.waiting); } catch { /* UI failures must not affect provider requests. */ }
  }

  async run<T>(request: () => Promise<T>, messages: Message[], signal?: AbortSignal): Promise<T> {
    // Only one automatic replay. A further rejection stops rather than creating
    // an unbounded retry loop against a stale or inaccurate reset timestamp.
    const operationCancellation = this.cancellation.signal;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0 && operationCancellation.aborted) {
        throw new Error("Claude Code billing/usage limit: automatic resumption cancelled; no retry was sent.");
      }
      try {
        return await request();
      } catch (error) {
        if (!(error instanceof ClaudeRateLimitError)) throw error;
        const reset = findLimitReset(error, messages, this.clock.now());
        const description = describeUsageLimit(error, reset, this.clock.now());
        if (!this.enabled || !reset || attempt > 0) {
          error.message = description + (attempt > 0 ? " Automatic retry was also rejected; stopped." :
            ` Auto-resume is ${this.enabled ? "on, but no usable reset is known" : "off"}. Use ${AUTO_RESUME_COMMAND} on|off|status.`);
          throw error;
        }
        const key = Symbol();
        const combined = signal ? AbortSignal.any([signal, operationCancellation]) : operationCancellation;
        this.pending.set(key, `${description} Request paused; it will retry automatically after reset. Cancel the turn or use ${AUTO_RESUME_COMMAND} off to stop.`);
        this.report();
        try {
          // Short chunks avoid Node's ~24-day timer overflow and recheck wall
          // clock changes. No Claude process/socket is held during this wait.
          while (this.clock.now() < reset.at * 1000 + 1000) {
            combined.throwIfAborted();
            await this.clock.sleep(Math.min(60_000, reset.at * 1000 + 1000 - this.clock.now()), combined);
          }
          combined.throwIfAborted();
        } catch (reason) {
          if (signal?.aborted) throw signal.reason;
          error.message = `${description} Automatic resumption cancelled; no retry was sent.`;
          throw error;
        } finally {
          this.pending.delete(key);
          this.report();
        }
      }
    }
  }
}
