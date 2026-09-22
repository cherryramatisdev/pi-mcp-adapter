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

// Cross-extension event bus for "MCP permission dialog is showing".
//
// The adapter and other extensions (e.g. notify-on-idle) run in the same pi
// process, so a slot on globalThis is enough to connect them. Both sides
// create-or-join the same Set, so registration order between extensions does
// not matter. Read-only and auto-approved actions never emit; this fires only
// when a real confirmation dialog is about to appear.
export const PERMISSION_ASK_LISTENERS_KEY = "__piMcpAdapterPermissionAskListeners__";

export interface PermissionAskDetail {
  serverName: string;
  toolName: string;
}

export type PermissionAskListener = (detail: PermissionAskDetail) => void;

/**
 * Notify other extensions that a permission dialog is about to be shown.
 * Listener errors are swallowed so a broken listener cannot block the gate.
 */
export function emitPermissionAsk(serverName: string, toolName: string): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const listeners = (globals[PERMISSION_ASK_LISTENERS_KEY] ?? new Set()) as Set<PermissionAskListener>;
  for (const listener of [...listeners]) {
    try {
      listener({ serverName, toolName });
    } catch {
      // A failing listener must not block the permission prompt.
    }
  }
}

/**
 * Subscribe to permission-ask events. Returns an unsubscribe function.
 */
export function onPermissionAsk(listener: PermissionAskListener): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const listeners = (globals[PERMISSION_ASK_LISTENERS_KEY] ??= new Set()) as Set<PermissionAskListener>;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
 * permission mode is "ask" and the tool is not read-only. Read-only tools
 * (server-declared `readOnlyHint` or resource reads) pass without prompting
 * since they cannot mutate server state. Returns `{ approved: true }`
 * immediately in "allow" mode. When "ask" is set but no interactive UI is
 * available, mutating actions are refused with a message explaining how to opt
 * out. Concurrent calls queue up; passing the tool-call `signal` dismisses the
 * dialog (or drops a queued prompt) when the call is interrupted.
 */
export async function confirmAction(
  config: McpConfig,
  serverName: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  ui: ExtensionContext["ui"] | undefined,
  signal?: AbortSignal,
  readOnly?: boolean,
): Promise<ActionConfirmation> {
  if (getActionPermission(config, serverName) === "allow") {
    return { approved: true };
  }

  if (readOnly) {
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
      () => {
        emitPermissionAsk(serverName, toolName);
        return signal
          ? ui.confirm("MCP action permission", message, { signal })
          : ui.confirm("MCP action permission", message);
      },
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
