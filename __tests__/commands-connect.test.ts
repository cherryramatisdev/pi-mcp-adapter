import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = {
  authenticate: vi.fn(),
  removeAuth: vi.fn(),
};

vi.mock("../mcp-auth-flow.ts", () => ({
  supportsOAuth: (definition: any) => definition?.auth === "oauth",
  authenticate: mocks.authenticate,
  removeAuth: mocks.removeAuth,
}));

describe("mcp connect dialog", () => {
  const originalHome = process.env.HOME;
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.removeAuth.mockReset();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
    process.chdir(originalCwd);
  });

  function createUi(selectResult?: string) {
    return {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(async () => selectResult),
      confirm: vi.fn(async () => true),
    };
  }

  function createManager() {
    return {
      getConnection: vi.fn(() => null),
      close: vi.fn(async () => {}),
      connect: vi.fn(async () => ({
        status: "connected",
        tools: [{ name: "do_something", description: "Does something" }],
        resources: [],
      })),
      getAllConnections: () => new Map(),
    };
  }

  function createState(server: Record<string, unknown>, manager = createManager()) {
    return {
      config: { mcpServers: server },
      manager,
      toolMetadata: new Map(),
      failureTracker: new Map(),
    };
  }

  it("warns and opens no dialog when no servers are configured", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-connect-empty-"));
    const ui = createUi();
    const { openMcpConnectDialog } = await import("../commands.ts");

    await openMcpConnectDialog(createState({}) as any, { getFlag: () => undefined } as any, { hasUI: true, ui } as any);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No MCP servers configured"),
      "warning",
    );
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("shows server labels with status and connects the picked server", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-connect-"));
    const manager = createManager();
    const ui = createUi("chrome-devtools  ○ idle");
    const { openMcpConnectDialog } = await import("../commands.ts");

    await openMcpConnectDialog(
      createState({ "chrome-devtools": { command: "npx" } }, manager) as any,
      { getFlag: () => undefined } as any, { hasUI: true, ui } as any,
    );

    expect(ui.select).toHaveBeenCalledWith(
      "Connect MCP server:",
      expect.arrayContaining(["chrome-devtools  ○ idle"]),
    );
    expect(manager.close).toHaveBeenCalledWith("chrome-devtools");
    expect(manager.connect).toHaveBeenCalledWith("chrome-devtools", { command: "npx" });
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Reconnected to chrome-devtools"),
      "info",
    );
  });

  it("does nothing when the dialog is cancelled", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-connect-cancel-"));
    const manager = createManager();
    const ui = createUi(undefined);
    const { openMcpConnectDialog } = await import("../commands.ts");

    await openMcpConnectDialog(
      createState({ "chrome-devtools": { command: "npx" } }, manager) as any,
      { getFlag: () => undefined } as any, { hasUI: true, ui } as any,
    );

    expect(manager.connect).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Reconnected"), "info");
  });

  it("runs OAuth first when the picked server needs auth, then connects", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-connect-oauth-"));
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-connect-oauth-dir-"));
    const manager = createManager();
    const ui = createUi("linear-server  ⚠ needs auth");
    const { openMcpConnectDialog } = await import("../commands.ts");

    await openMcpConnectDialog(
      createState(
        { "linear-server": { url: "https://example.com/mcp", auth: "oauth" } },
        manager,
      ) as any,
      { getFlag: () => undefined } as any, { hasUI: true, ui } as any,
    );

    expect(ui.select).toHaveBeenCalledWith(
      "Connect MCP server:",
      expect.arrayContaining(["linear-server  ⚠ needs auth"]),
    );
    expect(ui.confirm).toHaveBeenCalledWith(
      "Authenticate linear-server?",
      expect.stringContaining("requires OAuth"),
    );
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "linear-server",
      "https://example.com/mcp",
      expect.objectContaining({ url: "https://example.com/mcp", auth: "oauth" }),
    );
    expect(manager.connect).toHaveBeenCalledWith(
      "linear-server",
      expect.objectContaining({ url: "https://example.com/mcp" }),
    );
  });

  it("skips OAuth and connecting when the user declines the auth prompt", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-connect-decline-"));
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-connect-decline-dir-"));
    const manager = createManager();
    const ui = createUi("linear-server  ⚠ needs auth");
    ui.confirm.mockResolvedValue(false);
    const { openMcpConnectDialog } = await import("../commands.ts");

    await openMcpConnectDialog(
      createState(
        { "linear-server": { url: "https://example.com/mcp", auth: "oauth" } },
        manager,
      ) as any,
      { getFlag: () => undefined } as any, { hasUI: true, ui } as any,
    );

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("does nothing in non-UI sessions", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-connect-noui-"));
    const ui = createUi("anything");
    const { openMcpConnectDialog } = await import("../commands.ts");

    await openMcpConnectDialog(createState({ "s": { command: "npx" } }) as any, { getFlag: () => undefined } as any, { hasUI: false, ui } as any);

    expect(ui.select).not.toHaveBeenCalled();
  });
});
