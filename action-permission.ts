import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActionPermission, McpConfig } from "./types.ts";

/**
 * Resolve the permission mode for running actions on a server.
 * Per-server `actionPermission` overrides the global setting; the default is
 * "ask" (confirm with the user before every action).
 */
export function getActionPermission(config: McpConfig, serverName: string): ActionPermission {
  const serverPermission = config.mcpServers[serverName]?.actionPermission;
  if (serverPermission === "ask" || serverPermission === "allow") {
    return serverPermission;
  }
  return config.settings?.actionPermission === "allow" ? "allow" : "ask";
}

function formatActionArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  try {
    const text = JSON.stringify(args);
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  } catch {
    return "";
  }
}

export interface ActionConfirmation {
  approved: boolean;
  reason?: string;
}

class PromptCancelledError extends Error {}

/**
 * Pi's interactive mode exposes only a single dialog slot. Tool calls run in
 * parallel by default, so two concurrent `ui.confirm()` calls clobber each
 * other: the second replaces the first component and the first promise never
 * resolves, hanging the turn. Serialize prompts so only one is on screen at a
 * time, and let each waiter bail out when its call is aborted.
 */
let promptQueue: Promise<void> = Promise.resolve();

async function runPromptExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = promptQueue;
  let release!: () => void;
  promptQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    if (signal?.aborted) throw new PromptCancelledError();
    await new Promise<void>((resolve, reject) => {
      if (!signal) {
        previous.then(resolve, resolve);
        return;
      }
      const onAbort = () => reject(new PromptCancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      previous.then(settle, settle);
    });
    return await fn();
  } finally {
    release();
  }
}

/**
 * Ask the user for permission before running an MCP action when the effective
 * permission mode is "ask". Returns `{ approved: true }` immediately in "allow"
 * mode. When "ask" is set but no interactive UI is available, the action is
 * refused with a message explaining how to opt out. Concurrent calls queue up;
 * passing the tool-call `signal` dismisses the dialog (or drops a queued prompt)
 * when the call is interrupted.
 */
export async function confirmAction(
  config: McpConfig,
  serverName: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  ui: ExtensionContext["ui"] | undefined,
  signal?: AbortSignal,
): Promise<ActionConfirmation> {
  if (getActionPermission(config, serverName) === "allow") {
    return { approved: true };
  }

  if (!ui) {
    return {
      approved: false,
      reason: `MCP action "${toolName}" on "${serverName}" was not run: settings.actionPermission is "ask" but this session has no interactive UI. Set settings.actionPermission to "allow" (or server-level actionPermission) to run MCP actions without confirmation.`,
    };
  }

  const argsText = formatActionArgs(args);
  const message = argsText
    ? `Run "${toolName}" from MCP server "${serverName}"?\n\nArguments: ${argsText}`
    : `Run "${toolName}" from MCP server "${serverName}"?`;

  let approved: boolean;
  try {
    approved = await runPromptExclusive(
      () => signal
        ? ui.confirm("MCP action permission", message, { signal })
        : ui.confirm("MCP action permission", message),
      signal,
    );
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      return {
        approved: false,
        reason: `MCP action "${toolName}" on "${serverName}" was cancelled before running.`,
      };
    }
    throw error;
  }

  if (!approved) {
    return {
      approved: false,
      reason: signal?.aborted
        ? `MCP action "${toolName}" on "${serverName}" was cancelled before running.`
        : `MCP action "${toolName}" on "${serverName}" was declined by the user.`,
    };
  }
  return { approved: true };
}
