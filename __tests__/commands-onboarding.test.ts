import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("commands dialogs", () => {
  const originalHome = process.env.HOME;
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
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

  function createState(servers: Record<string, unknown> = {}) {
    return {
      config: { mcpServers: servers },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    };
  }

  it("shows a one-time shared-config notice before the connect dialog", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-dialog-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-dialog-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        sharedServer: { command: "shared" },
      },
    });

    const ui = createUi(undefined);
    const { openMcpConnectDialog } = await import("../commands.ts");
    const { loadOnboardingState } = await import("../onboarding-state.ts");

    const first = await openMcpConnectDialog(
      createState({ sharedServer: { command: "shared" } }) as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui } as any,
    );
    const second = await openMcpConnectDialog(
      createState({ sharedServer: { command: "shared" } }) as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui } as any,
    );

    expect(first.configChanged).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Using standard MCP config"), "info");
    expect(loadOnboardingState().sharedConfigHintShown).toBe(true);
    // The notice only fires once per fingerprint.
    const noticeCalls = ui.notify.mock.calls.filter((call) => String(call[0]).includes("Using standard MCP config"));
    expect(noticeCalls).toHaveLength(1);
    expect(second.configChanged).toBe(false);
  });

  it("lists explicit OAuth servers as needing auth when only stale URL tokens exist", async () => {
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-dialog-oauth-"));
    const ui = createUi(undefined);
    const { updateTokens } = await import("../mcp-auth.ts");
    const { openMcpConnectDialog } = await import("../commands.ts");

    updateTokens("legacy", { accessToken: "legacy-token" });
    updateTokens("stale", { accessToken: "stale-token" }, "https://old.example.com/mcp");

    await openMcpConnectDialog(
      createState({
        legacy: { url: "https://new.example.com/mcp", auth: "oauth" },
        stale: { url: "https://new.example.com/mcp", auth: "oauth" },
      }) as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui } as any,
    );

    const labels = ui.select.mock.calls[0]?.[1];
    expect(labels).toContain("legacy  ⚠ needs auth");
    expect(labels).toContain("stale  ⚠ needs auth");
  });

  it("scaffolds a project .mcp.json from the setup dialog", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-dialog-setup-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-dialog-setup-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const ui = createUi("Scaffold project .mcp.json");
    const { openMcpSetupDialog } = await import("../commands.ts");

    const result = await openMcpSetupDialog(
      createState() as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, ui, cwd: project } as any,
    );

    expect(result.configChanged).toBe(true);
    expect(existsSync(join(project, ".mcp.json"))).toBe(true);
    expect(ui.confirm).toHaveBeenCalledWith(
      "Scaffold project .mcp.json?",
      expect.stringContaining(project),
    );
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Pi will reload after this dialog closes"),
      "info",
    );
  });

  it("clears OAuth credentials, cancels pending auth, and closes the server on logout", async () => {
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-dialog-logout-"));
    const ui = createUi();
    const close = vi.fn();
    const { getAuthEntry, updateOAuthState, updateTokens } = await import("../mcp-auth.ts");
    const { waitForCallback } = await import("../mcp-callback-server.ts");
    const { logoutServer } = await import("../commands.ts");

    updateTokens("oauth-server", { accessToken: "token", refreshToken: "refresh" }, "https://example.com/mcp");
    updateOAuthState("oauth-server", "pending-state", "https://example.com/mcp");
    const pendingCallback = waitForCallback("pending-state");
    const pendingCallbackRejection = expect(pendingCallback).rejects.toThrow("Authorization cancelled");

    const result = await logoutServer("oauth-server", {
      config: { mcpServers: { "oauth-server": { url: "https://example.com/mcp", auth: "oauth" } } },
      manager: { close },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { hasUI: true, ui } as any);

    await pendingCallbackRejection;
    expect(result.ok).toBe(true);
    expect(getAuthEntry("oauth-server")).toBeUndefined();
    expect(close).toHaveBeenCalledWith("oauth-server");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("OAuth credentials cleared"), "info");
  });
});
