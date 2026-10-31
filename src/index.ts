import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getClaudeStatus } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider } from "./provider.ts";
import { AUTO_RESUME_COMMAND, AUTO_RESUME_ENTRY, UsageLimitController } from "./usage-limits.ts";

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  const usageLimits = new UsageLimitController();
  pi.registerProvider(createClaudeCodeProvider(usageLimits));

  function restore(ctx: ExtensionContext): void {
    usageLimits.cancelPending();
    let enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === AUTO_RESUME_ENTRY) {
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") enabled = data.enabled;
      }
    }
    usageLimits.setEnabled(enabled);
    usageLimits.onWait = (message) => {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus("claude-code-limit", message ? "Claude usage limit: waiting for reset" : undefined);
      if (message) ctx.ui.notify(message, "warning");
    };
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    usageLimits.cancelPending();
    usageLimits.onWait = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("claude-code-limit", undefined);
  });

  pi.registerCommand("claude-code-auto-resume", {
    description: "Toggle waiting for Claude usage resets (on|off|status; saved in this session)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) {
        ctx.ui.notify(`Usage: ${AUTO_RESUME_COMMAND} [on|off|status]`, "error");
        return;
      }
      if (action !== "status") {
        const enabled = action === "" ? !usageLimits.enabled : action === "on";
        usageLimits.setEnabled(enabled);
        pi.appendEntry(AUTO_RESUME_ENTRY, { enabled });
      }
      ctx.ui.notify(`Claude usage-limit auto-resume is ${usageLimits.enabled ? "ON" : "OFF"}. ` +
        ((usageLimits.enabled ? usageLimits.waiting : undefined) ??
          "Applies to future rejected requests; it does not restart a finished turn."), "info");
    },
  });

  pi.registerCommand("claude-code-status", {
    description: "Check the Claude Code executable and subscription login",
    handler: async (_args, ctx) => {
      const status = await getClaudeStatus(claudeCodeEnv(), ctx.signal);
      if (!status.available || !status.loggedIn) {
        ctx.ui.notify(status.detail ?? "Claude Code is not ready", "error");
        return;
      }
      const plan = status.plan ? ` (${status.plan})` : "";
      ctx.ui.notify(`Claude Code is installed and logged in${plan}`, "info");
    },
  });
}

export { createClaudeCodeProvider } from "./provider.ts";
export { streamClaudeCode } from "./stream.ts";
