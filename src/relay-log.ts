import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export const relayLogPath = join("/tmp", `pi-claude-code-relay-${process.pid}.jsonl`);

/** Only record transport fields: arbitrary error messages/stacks can contain payloads. */
export function transportError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth >= 6) return { truncated: true };
  if (!error || typeof error !== "object") return { name: "UnknownError" };
  const source = error as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["name", "code", "errno", "syscall", "address", "port", "hostname"]) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  if (source.cause) result.cause = transportError(source.cause, depth + 1);
  if (Array.isArray(source.errors)) {
    result.errors = source.errors.slice(0, 16).map((item) => transportError(item, depth + 1));
  }
  return result;
}

/** Logging must never change request behavior. No raw headers, bodies, or auth are accepted here. */
export async function appendRelayLog(record: Record<string, unknown>, path = relayLogPath): Promise<void> {
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return;
      await file.writeFile(`${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...record })}\n`);
    } finally {
      await file.close();
    }
  } catch {
    // Disk full, permissions, and unavailable /tmp must not break model requests.
  }
}
