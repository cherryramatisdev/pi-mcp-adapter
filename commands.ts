import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { McpAuthResult, McpConfig, ServerEntry, ImportKind } from "./types.ts";
import {
  ensureCompatibilityImports,
  getMcpDiscoverySummary,
  getServerProvenance,
  writeDirectToolsConfig,
  writeSharedServerEntry,
  writeStarterProjectConfig,
  type McpDiscoverySummary,
} from "./config.ts";
import { updateMetadataCache, updateStatusBar, getFailureAgeSeconds } from "./init.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import { supportsOAuth, authenticate, removeAuth } from "./mcp-auth-flow.ts";
import { getAuthForUrl } from "./mcp-auth.ts";
import { isToolExcluded } from "./types.ts";
import { loadOnboardingState, markSetupCompleted as persistSetupCompleted, markSharedConfigHintShown } from "./onboarding-state.ts";
import { openPath } from "./utils.ts";

function getServerConnectionStatus(
  state: McpExtensionState,
  serverName: string,
): "connected" | "idle" | "failed" | "needs-auth" {
  const definition = state.config.mcpServers[serverName];
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    return "needs-auth";
  }
  if (
    definition?.auth === "oauth"
    && definition.url
    && definition.oauth !== false
    && definition.oauth?.grantType !== "client_credentials"
    && !getAuthForUrl(serverName, definition.url)?.tokens
  ) {
    return "needs-auth";
  }
  if (connection?.status === "connected") return "connected";
  if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
  return "idle";
}

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (connection?.status === "needs-auth") {
      status = "needs auth";
      statusIcon = "⚠";
    } else if (failedAgo !== null) {
      status = `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (metadata !== undefined) {
      status = "cached";
    }

    const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
    lines.push("Run /mcp setup to adopt imports or scaffold a starter .mcp.json");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const allTools = [...state.toolMetadata.values()].flat().map(m => m.name);

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }

  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Default /mcp flow using stock Pi dialogs. Shows the shared-config heads-up
 * once, then lets the user pick a server to connect. Runs OAuth first when
 * the server needs it.
 */
export async function openMcpConnectDialog(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const { lines: noticeLines, fingerprint } = buildSharedConfigNoticeLines(configPath, ctx.cwd);
  if (noticeLines.length > 0) {
    ctx.ui.notify(noticeLines.join("\n"), "info");
    if (fingerprint) markSharedConfigHintShown(fingerprint);
  }

  const serverNames = Object.keys(state.config.mcpServers);
  if (serverNames.length === 0) {
    ctx.ui.notify("No MCP servers configured. Run /mcp setup to get started.", "warning");
    return { configChanged: false };
  }

  const labels = serverNames.map((name) => {
    const status = getServerConnectionStatus(state, name);
    const toolCount = state.toolMetadata.get(name)?.length ?? 0;
    switch (status) {
      case "connected":
        return `${name}  ✓ connected${toolCount > 0 ? ` · ${toolCount} tools` : ""}`;
      case "needs-auth":
        return `${name}  ⚠ needs auth`;
      case "failed":
        return `${name}  ✗ failed`;
      default:
        return `${name}  ○ idle${toolCount > 0 ? ` · ${toolCount} tools cached` : ""}`;
    }
  });

  const choice = await ctx.ui.select("Connect MCP server:", labels);
  if (!choice) return { configChanged: false };

  const index = labels.indexOf(choice);
  if (index < 0) return { configChanged: false };
  const serverName = serverNames[index];

  const status = getServerConnectionStatus(state, serverName);
  if (status === "needs-auth") {
    const startAuth = await ctx.ui.confirm(
      `Authenticate ${serverName}?`,
      `${serverName} requires OAuth before it can connect. Start the OAuth flow now?`,
    );
    if (!startAuth) return { configChanged: false };
    const authResult = await authenticateServer(serverName, state.config, ctx);
    if (!authResult.ok) return { configChanged: false };
  }

  await reconnectServers(state, ctx, serverName);
  return { configChanged: false };
}

export async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const entries = targetServer
    ? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
    : Object.entries(state.config.mcpServers);

  for (const [name, definition] of entries) {
    try {
      await state.manager.close(name);

      const connection = await state.manager.connect(name, definition);
      if (connection.status === "needs-auth") {
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP: ${name} requires OAuth. Run /mcp-auth ${name} first.`, "warning");
        }
        continue;
      }
      const prefix = state.config.settings?.toolPrefix ?? "server";

      const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
      state.toolMetadata.set(name, metadata);
      updateMetadataCache(state, name);
      state.failureTracker.delete(name);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
          "info"
        );
        if (failedTools.length > 0) {
          ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.failureTracker.set(name, Date.now());
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
      }
    }
  }

  updateStatusBar(state);
}

export async function authenticateServer(
  serverName: string,
  config: McpConfig,
  ctx: ExtensionContext
): Promise<McpAuthResult> {
  if (!ctx.hasUI) return { ok: false, message: "OAuth authentication requires an interactive session." };

  const definition = config.mcpServers[serverName];
  if (!definition) {
    const message = `Server "${serverName}" not found in config`;
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  }

  if (!supportsOAuth(definition)) {
    const message = `Server "${serverName}" does not use OAuth authentication. Set "auth": "oauth" or omit auth for auto-detection.`;
    ctx.ui.notify(
      `Server "${serverName}" does not use OAuth authentication.\n` +
      `Set "auth": "oauth" or omit auth for auto-detection.`,
      "error"
    );
    return { ok: false, message };
  }

  if (!definition.url) {
    const message = `Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`;
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  }

  try {
    ctx.ui.setStatus("mcp-auth", `Authenticating ${serverName}...`);
    const status = await authenticate(serverName, definition.url, definition);

    if (status === "authenticated") {
      const message = `OAuth authentication successful for "${serverName}"! Run /mcp reconnect ${serverName} to connect with the new token.`;
      ctx.ui.notify(
        `OAuth authentication successful for "${serverName}"!\n` +
        `Run /mcp reconnect ${serverName} to connect with the new token.`,
        "info"
      );
      return { ok: true, message };
    }

    const message = `OAuth authentication failed for "${serverName}".`;
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to authenticate "${serverName}": ${message}`, "error");
    return { ok: false, message };
  } finally {
    ctx.ui.setStatus("mcp-auth", undefined);
  }
}

export async function logoutServer(
  serverName: string,
  state: McpExtensionState,
  ctx: ExtensionContext
): Promise<{ ok: boolean; message: string }> {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    const message = `Server "${serverName}" not found in config`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    return { ok: false, message };
  }

  await removeAuth(serverName);
  await state.manager.close(serverName);
  updateStatusBar(state);

  const message = `OAuth credentials cleared for "${serverName}". Run /mcp-auth ${serverName} to authenticate again.`;
  if (ctx.hasUI) ctx.ui.notify(message, "info");
  return { ok: true, message };
}

export interface PanelFlowResult {
  configChanged: boolean;
}

function buildSharedConfigNoticeLines(configOverridePath: string | undefined, cwd: string): { lines: string[]; fingerprint: string | null } {
  const discovery = getMcpDiscoverySummary(configOverridePath, cwd);
  const onboardingState = loadOnboardingState();
  if (!discovery.hasSharedServers || onboardingState.sharedConfigHintShown) {
    return { lines: [], fingerprint: null };
  }

  const sharedSources = discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0);
  const sourceList = sharedSources.map((source) => source.path).join(", ");
  return {
    lines: [
      `Using standard MCP config from ${sourceList}.`,
      "Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
    ],
    fingerprint: discovery.fingerprint,
  };
}

interface SetupOption {
  id: "imports" | "scaffold" | "repoprompt" | "paths" | "example" | "precedence" | "close";
  label: string;
}

function getDetectedPaths(discovery: McpDiscoverySummary): string[] {
  return [...new Set([
    ...discovery.sources.filter((source) => source.exists).map((source) => source.path),
    ...discovery.imports.map((entry) => entry.path),
  ])];
}

function buildSetupOptions(discovery: McpDiscoverySummary): SetupOption[] {
  const options: SetupOption[] = [];
  if (discovery.imports.length > 0) {
    options.push({
      id: "imports",
      label: `Adopt compatibility imports (${discovery.imports.length} source${discovery.imports.length === 1 ? "" : "s"} found)`,
    });
  }
  if (!discovery.sources.some((source) => source.id === "shared-project" && source.exists)) {
    options.push({ id: "scaffold", label: "Scaffold project .mcp.json" });
  }
  const repoPrompt = discovery.repoPrompt;
  if (!repoPrompt.configured && repoPrompt.executablePath && repoPrompt.targetPath && repoPrompt.entry && repoPrompt.serverName) {
    options.push({ id: "repoprompt", label: "Add RepoPrompt to shared MCP config" });
  }
  if (getDetectedPaths(discovery).length > 0) {
    options.push({ id: "paths", label: "Open detected config paths" });
  }
  options.push({ id: "example", label: "View example .mcp.json" });
  options.push({ id: "precedence", label: "Explain config precedence" });
  options.push({ id: "close", label: "Close" });
  return options;
}

/**
 * Guided setup flow using stock Pi dialogs: adopt compatibility imports,
 * scaffold a minimal .mcp.json, add RepoPrompt, inspect paths, and review
 * examples/precedence. Actions that write config return configChanged so the
 * caller can reload Pi.
 */
export async function openMcpSetupDialog(
  _state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const discovery = getMcpDiscoverySummary(configOverridePath, ctx.cwd);
  const onboardingState = loadOnboardingState();
  let configChanged = false;

  if (!discovery.hasAnyConfig && !onboardingState.setupCompleted) {
    ctx.ui.notify(
      "No MCP config is active yet. Setup can scaffold a starter .mcp.json or adopt configs from other tools.",
      "info",
    );
  }

  while (true) {
    const options = buildSetupOptions(discovery);
    const labels = options.map((option) => option.label);
    const pick = await ctx.ui.select("MCP setup:", labels);
    if (!pick) return { configChanged };
    const option = options.find((o) => o.label === pick);
    if (!option) return { configChanged };

    switch (option.id) {
      case "imports": {
        const accepted: ImportKind[] = [];
        for (const entry of discovery.imports) {
          const ok = await ctx.ui.confirm(
            `Adopt ${entry.kind}?`,
            `${entry.path} — ${entry.serverCount} server${entry.serverCount === 1 ? "" : "s"}. Writes a "${entry.kind}" compatibility import into the Pi agent dir config.`,
          );
          if (ok) accepted.push(entry.kind);
        }
        if (accepted.length === 0) {
          ctx.ui.notify("No compatibility imports selected.", "info");
          break;
        }
        const result = ensureCompatibilityImports(accepted, configOverridePath);
        persistSetupCompleted(discovery.fingerprint);
        if (result.added.length > 0) {
          configChanged = true;
          ctx.ui.notify(`Added ${result.added.join(", ")} to ${result.path}. Pi will reload after this dialog closes.`, "info");
          return { configChanged: true };
        }
        ctx.ui.notify(`No changes needed in ${result.path}.`, "info");
        break;
      }
      case "scaffold": {
        const ok = await ctx.ui.confirm(
          "Scaffold project .mcp.json?",
          `Writes a minimal .mcp.json in ${ctx.cwd} using the shared MCP layout.`,
        );
        if (!ok) break;
        const path = writeStarterProjectConfig(ctx.cwd);
        persistSetupCompleted(discovery.fingerprint);
        configChanged = true;
        ctx.ui.notify(`Wrote starter config to ${path}. Pi will reload after this dialog closes.`, "info");
        return { configChanged: true };
      }
      case "repoprompt": {
        const repoPrompt = discovery.repoPrompt;
        if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) break;
        const ok = await ctx.ui.confirm(
          `Add ${repoPrompt.serverName}?`,
          `Adds a standard MCP entry for RepoPrompt (${repoPrompt.executablePath ?? "npx"}) to ${repoPrompt.targetPath}.`,
        );
        if (!ok) break;
        const path = writeSharedServerEntry(repoPrompt.targetPath, repoPrompt.serverName, repoPrompt.entry);
        persistSetupCompleted(discovery.fingerprint);
        configChanged = true;
        ctx.ui.notify(`Added ${repoPrompt.serverName} to ${path}. Pi will reload after this dialog closes.`, "info");
        return { configChanged: true };
      }
      case "paths": {
        const paths = getDetectedPaths(discovery);
        const pickPath = await ctx.ui.select("Open config path:", paths);
        if (pickPath) await openPath(pi, pickPath);
        break;
      }
      case "example":
        ctx.ui.notify(
          "Example shared .mcp.json:\n" +
          '{\n  "mcpServers": {\n    "chrome-devtools": {\n      "command": "npx",\n      "args": ["-y", "chrome-devtools-mcp@latest"]\n    }\n  }\n}',
          "info",
        );
        break;
      case "precedence":
        ctx.ui.notify(
          "Config read order:\n" +
          "1. ~/.config/mcp/mcp.json\n" +
          "2. <Pi agent dir>/mcp.json\n" +
          "3. .mcp.json\n" +
          "4. .pi/mcp.json\n" +
          "Pi writes compatibility imports and adapter-only overrides to Pi-owned files.",
          "info",
        );
        break;
      case "close":
      default:
        return { configChanged };
    }
  }
}

/**
 * OAuth picker using stock dialogs: pick an OAuth-capable server and run the
 * authorization flow.
 */
export async function openMcpAuthDialog(
  state: McpExtensionState,
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  _configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const oauthServers = Object.entries(state.config.mcpServers).filter(([, definition]) => supportsOAuth(definition));
  if (oauthServers.length === 0) {
    ctx.ui.notify("No OAuth-capable MCP servers are configured.", "warning");
    return { configChanged: false };
  }

  const labels = oauthServers.map(([name]) => {
    const status = getServerConnectionStatus(state, name);
    const statusText = status === "needs-auth"
      ? "⚠ needs auth"
      : status === "connected"
        ? "✓ connected"
        : status === "failed"
          ? "✗ failed"
          : "○ idle";
    return `${name}  ${statusText}`;
  });

  const choice = await ctx.ui.select("Authenticate with:", labels);
  if (!choice) return { configChanged: false };

  const index = labels.indexOf(choice);
  if (index < 0) return { configChanged: false };
  await authenticateServer(oauthServers[index][0], state.config, ctx);
  return { configChanged: false };
}

/**
 * Direct/proxy tool toggling using stock dialogs. Picks a server, toggles
 * individual tools, and writes the resulting directTools config.
 */
export async function toggleDirectToolsDialog(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const serverNames = Object.keys(state.config.mcpServers);
  if (serverNames.length === 0) {
    ctx.ui.notify("No MCP servers configured.", "warning");
    return { configChanged: false };
  }

  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);
  const cache = loadMetadataCache();
  const prefix = state.config.settings?.toolPrefix ?? "server";

  const serverPick = await ctx.ui.select("Toggle direct tools for:", serverNames);
  if (!serverPick) return { configChanged: false };
  const serverIndex = serverNames.indexOf(serverPick);
  if (serverIndex < 0) return { configChanged: false };
  const serverName = serverNames[serverIndex];

  const definition = state.config.mcpServers[serverName];
  const cachedTools = cache?.servers?.[serverName]?.tools ?? [];
  if (cachedTools.length === 0) {
    ctx.ui.notify(`No cached tools for ${serverName}. Connect it first (/mcp), then try again.`, "warning");
    return { configChanged: false };
  }

  const globalDirect = state.config.settings?.directTools;
  let toolFilter: true | string[] | false = false;
  if (definition.directTools !== undefined) toolFilter = definition.directTools;
  else if (globalDirect) toolFilter = globalDirect;

  const toolNames = cachedTools
    .map((tool) => tool.name)
    .filter((name) => !isToolExcluded(name, serverName, prefix, definition.excludeTools));
  if (toolNames.length === 0) {
    ctx.ui.notify(`No toggleable tools for ${serverName}.`, "warning");
    return { configChanged: false };
  }

  const isDirect = new Map<string, boolean>(
    toolNames.map((name) => [
      name,
      toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(name)),
    ]),
  );

  let dirty = false;
  while (true) {
    const labels = [...isDirect.entries()].map(([name, direct]) => `${direct ? "●" : "○"} ${name}`);
    const doneLabel = "Done — save changes";
    const pick = await ctx.ui.select(`Direct tools for ${serverName}:`, [...labels, doneLabel]);
    if (!pick || pick === doneLabel) break;
    const labelIndex = labels.indexOf(pick);
    if (labelIndex < 0) break;
    const name = toolNames[labelIndex];
    isDirect.set(name, !isDirect.get(name)!);
    dirty = true;
  }

  if (!dirty) {
    ctx.ui.notify("No direct-tool changes made.", "info");
    return { configChanged: false };
  }

  const directNames = [...isDirect.entries()].filter(([, direct]) => direct).map(([name]) => name);
  const changes = new Map<string, true | string[] | false>();
  if (directNames.length === isDirect.size && isDirect.size > 0) {
    changes.set(serverName, true);
  } else if (directNames.length === 0) {
    changes.set(serverName, false);
  } else {
    changes.set(serverName, directNames);
  }

  writeDirectToolsConfig(changes, provenanceMap, state.config);
  if (provenanceMap.get(serverName)?.kind === "import") {
    ctx.ui.notify(
      "This server is imported from an external config — the direct-tools override is written to the Pi agent dir config.",
      "info",
    );
  }
  ctx.ui.notify("Direct tools updated. Pi will reload after this dialog closes.", "info");
  return { configChanged: true };
}
