import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Command-mode tests: pi started WITHOUT --mcp, MCP activated via /enable-mcp.
// This file must NOT have --mcp in process.argv (vitest runs each file in its
// own process, so it does not interfere with index-lifecycle.test.ts).

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  loadMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  loadMetadataCache: vi.fn(() => null),
  buildProxyDescription: vi.fn(() => "MCP gateway"),
  createDirectToolExecutor: vi.fn(() => vi.fn()),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
  showStatus: vi.fn(),
  showTools: vi.fn(),
  reconnectServers: vi.fn(),
  authenticateServer: vi.fn(),
  logoutServer: vi.fn(),
  openMcpConnectDialog: vi.fn(),
  openMcpSetupDialog: vi.fn(),
  openMcpAuthDialog: vi.fn(),
  toggleDirectToolsDialog: vi.fn(),
  executeAuthComplete: vi.fn(),
  executeAuthStart: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeStatus: vi.fn(),
  executeUiMessages: vi.fn(),
  getConfigPathFromArgv: vi.fn(() => undefined),
  truncateAtWord: vi.fn((text: string) => text),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: mocks.updateStatusBar,
  flushMetadataCache: mocks.flushMetadataCache,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: mocks.initializeOAuth,
  shutdownOAuth: mocks.shutdownOAuth,
}));

vi.mock("../config.ts", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../metadata-cache.ts", () => ({
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tools.ts", () => ({
  buildProxyDescription: mocks.buildProxyDescription,
  createDirectToolExecutor: mocks.createDirectToolExecutor,
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  resolveDirectTools: mocks.resolveDirectTools,
}));

vi.mock("../commands.ts", () => ({
  showStatus: mocks.showStatus,
  showTools: mocks.showTools,
  reconnectServers: mocks.reconnectServers,
  authenticateServer: mocks.authenticateServer,
  logoutServer: mocks.logoutServer,
  openMcpConnectDialog: mocks.openMcpConnectDialog,
  openMcpSetupDialog: mocks.openMcpSetupDialog,
  openMcpAuthDialog: mocks.openMcpAuthDialog,
  toggleDirectToolsDialog: mocks.toggleDirectToolsDialog,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeAuthComplete: mocks.executeAuthComplete,
  executeAuthStart: mocks.executeAuthStart,
  executeCall: mocks.executeCall,
  executeConnect: mocks.executeConnect,
  executeDescribe: mocks.executeDescribe,
  executeList: mocks.executeList,
  executeSearch: mocks.executeSearch,
  executeStatus: mocks.executeStatus,
  executeUiMessages: mocks.executeUiMessages,
}));

vi.mock("../utils.ts", () => ({
  getConfigPathFromArgv: mocks.getConfigPathFromArgv,
  truncateAtWord: mocks.truncateAtWord,
}));

function createState() {
  return {
    manager: { getAllConnections: () => new Map() },
    lifecycle: { gracefulShutdown: vi.fn().mockResolvedValue(undefined) },
    toolMetadata: new Map(),
    config: { mcpServers: {} },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
  } as any;
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      appendEntry: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getAllTools: vi.fn(() => []),
    } as any,
  };
}

function findCommand(api: any, name: string) {
  return api.registerCommand.mock.calls.find((call: any[]) => call[0] === name)?.[1];
}

describe("mcpAdapter command mode (/enable-mcp)", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

  beforeEach(() => {
    expect(process.argv.includes("--mcp")).toBe(false);
    delete process.env.MCP_DIRECT_TOOLS;
    vi.resetModules();
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) {
        value.mockReset();
      }
    }

    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn());
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.resolveDirectTools.mockReturnValue([]);
    mocks.getConfigPathFromArgv.mockReturnValue(undefined);
    mocks.truncateAtWord.mockImplementation((text: string) => text);
  });

  afterEach(() => {
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
  });

  it("is a complete no-op at startup: no MCP tools or commands, no init", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    expect(findCommand(api, "enable-mcp")).toBeDefined();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(findCommand(api, "mcp")).toBeUndefined();
    expect(findCommand(api, "mcp-auth")).toBeUndefined();

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, { sessionManager: { getEntries: () => [] } });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.initializeMcp).not.toHaveBeenCalled();
    expect(mocks.initializeOAuth).not.toHaveBeenCalled();
  });

  it("registers the MCP surface and initializes on /enable-mcp", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const enableMcp = findCommand(api, "enable-mcp");
    await enableMcp.handler("", { hasUI: true, ui, sessionManager: { getEntries: () => [] } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(api.appendEntry).toHaveBeenCalledWith("mcp-adapter", { enabled: true });
    expect(ui.notify).toHaveBeenCalledWith("MCP enabled. Run /mcp for status.", "info");
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
    expect(findCommand(api, "mcp")).toBeDefined();
    expect(findCommand(api, "mcp-auth")).toBeDefined();
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.initializeMcp).toHaveBeenCalledWith(api, expect.objectContaining({ hasUI: true }));

    // Subsequent /enable-mcp is a no-op: no duplicate entries or inits.
    await enableMcp.handler("", { hasUI: true, ui, sessionManager: { getEntries: () => [] } });
    expect(api.appendEntry).toHaveBeenCalledTimes(1);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
  });

  it("re-activates on session start when the session carries the enabled marker", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    const marker = [{ type: "custom", customType: "mcp-adapter", data: { enabled: true } }];
    await sessionStart?.({}, { sessionManager: { getEntries: () => marker } });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
  });

  it("does not re-activate for a session without the enabled marker", async () => {
    mocks.initializeMcp.mockResolvedValue(createState());

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { sessionManager: { getEntries: () => [] } });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  });
});

function apiFor(handlers: Map<string, (...args: any[]) => unknown>) {
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      appendEntry: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getAllTools: vi.fn(() => []),
    } as any,
  }.api;
}
