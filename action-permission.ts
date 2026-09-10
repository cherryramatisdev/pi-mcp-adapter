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

/**
 * Ask the user for permission before running an MCP action when the effective
 * permission mode is "ask". Returns `{ approved: true }` immediately in "allow"
 * mode. When "ask" is set but no interactive UI is available, the action is
 * refused with a message explaining how to opt out.
 */
export async function confirmAction(
  config: McpConfig,
  serverName: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  ui: ExtensionContext["ui"] | undefined,
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

  const approved = await ui.confirm("MCP action permission", message);
  if (!approved) {
    return {
      approved: false,
      reason: `MCP action "${toolName}" on "${serverName}" was declined by the user.`,
    };
  }
  return { approved: true };
}
