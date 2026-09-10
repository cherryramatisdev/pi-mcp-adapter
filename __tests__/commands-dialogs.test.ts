import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("mcp auth dialog", () => {
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

  it("picks an OAuth server and runs the authorization flow", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-authdialog-"));
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-authdialog-oauth-"));
    const ui = { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn(async () => "linear-server  ⚠ needs auth"), confirm: vi.fn() };
    const { openMcpAuthDialog } = await import("../commands.ts");

    const result = await openMcpAuthDialog(
      {
        config: { mcpServers: { "linear-server": { url: "https://example.com/mcp", auth: "oauth" } } },
        manager: { getConnection: () => null },
        toolMetadata: new Map(),
        failureTracker: new Map(),
      } as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui } as any,
    );

    expect(ui.select).toHaveBeenCalledWith(
      "Authenticate with:",
      expect.arrayContaining(["linear-server  ⚠ needs auth"]),
    );
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "linear-server",
      "https://example.com/mcp",
      expect.objectContaining({ url: "https://example.com/mcp", auth: "oauth" }),
    );
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("OAuth authentication successful"), "info");
    expect(result.configChanged).toBe(false);
  });

  it("warns when no OAuth-capable servers are configured", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-authdialog-none-"));
    const ui = { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn(), confirm: vi.fn() };
    const { openMcpAuthDialog } = await import("../commands.ts");

    await openMcpAuthDialog(
      { config: { mcpServers: { "stdio": { command: "npx" } } }, manager: { getConnection: () => null }, toolMetadata: new Map(), failureTracker: new Map() } as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui } as any,
    );

    expect(ui.notify).toHaveBeenCalledWith("No OAuth-capable MCP servers are configured.", "warning");
    expect(ui.select).not.toHaveBeenCalled();
  });
});

describe("mcp direct tools dialog", () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.chdir(originalCwd);
  });

  it("toggles a tool to direct and writes the config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-direct-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-direct-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      },
    });
    writeJson(join(home, ".pi", "agent", "mcp-cache.json"), {
      version: 1,
      servers: {
        "chrome-devtools": {
          configHash: "test",
          cachedAt: Date.now(),
          tools: [
            { name: "do_something", description: "Does something" },
            { name: "do_other", description: "Does other" },
          ],
          resources: [],
        },
      },
    });

    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("chrome-devtools")          // server pick
        .mockResolvedValueOnce("○ do_something")           // toggle first tool
        .mockResolvedValueOnce("Done — save changes"),     // save
      confirm: vi.fn(),
    };
    const { toggleDirectToolsDialog } = await import("../commands.ts");

    const result = await toggleDirectToolsDialog(
      {
        config: {
          settings: { toolPrefix: "server" },
          mcpServers: { "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] } },
        },
        manager: { getConnection: () => null },
        toolMetadata: new Map(),
        failureTracker: new Map(),
      } as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui, cwd: project } as any,
    );

    expect(result.configChanged).toBe(true);
    expect(ui.notify).toHaveBeenCalledWith("Direct tools updated. Pi will reload after this dialog closes.", "info");

    const written = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8"));
    expect(written.mcpServers["chrome-devtools"].directTools).toEqual(["do_something"]);
  });

  it("warns when the server has no cached tools yet", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-direct-nocache-"));
    process.env.HOME = home;
    const ui = { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn(async () => "chrome-devtools"), confirm: vi.fn() };
    const { toggleDirectToolsDialog } = await import("../commands.ts");

    const result = await toggleDirectToolsDialog(
      {
        config: { mcpServers: { "chrome-devtools": { command: "npx" } } },
        manager: { getConnection: () => null },
        toolMetadata: new Map(),
        failureTracker: new Map(),
      } as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui } as any,
    );

    expect(result.configChanged).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No cached tools for chrome-devtools"),
      "warning",
    );
  });
});
