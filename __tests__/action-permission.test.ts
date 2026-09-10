import { describe, expect, it, vi } from "vitest";
import { confirmAction, getActionPermission } from "../action-permission.ts";
import type { McpConfig } from "../types.ts";

function createConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    settings: {},
    mcpServers: {},
    ...overrides,
  };
}

describe("getActionPermission", () => {
  it("defaults to ask when nothing is configured", () => {
    expect(getActionPermission(createConfig(), "demo")).toBe("ask");
  });

  it("honors the global setting", () => {
    const config = createConfig({ settings: { actionPermission: "allow" } });
    expect(getActionPermission(config, "demo")).toBe("allow");
    const config2 = createConfig({ settings: { actionPermission: "ask" } });
    expect(getActionPermission(config2, "demo")).toBe("ask");
  });

  it("per-server overrides the global setting", () => {
    const config = createConfig({
      settings: { actionPermission: "ask" },
      mcpServers: { demo: { command: "demo", actionPermission: "allow" } },
    });
    expect(getActionPermission(config, "demo")).toBe("allow");
    expect(getActionPermission(config, "other")).toBe("ask");
  });

  it("rejects invalid per-server values and falls back to global", () => {
    const config = createConfig({
      settings: { actionPermission: "allow" },
      mcpServers: { demo: { command: "demo", actionPermission: "sometimes" as never } },
    });
    expect(getActionPermission(config, "demo")).toBe("allow");
  });
});

describe("confirmAction", () => {
  it("approves without prompting in allow mode", async () => {
    const ui = { confirm: vi.fn(async () => true) };
    const config = createConfig({ settings: { actionPermission: "allow" } });

    const result = await confirmAction(config, "demo", "search", { q: "x" }, ui as never);

    expect(result).toEqual({ approved: true });
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("prompts and approves when the user confirms", async () => {
    const ui = { confirm: vi.fn(async () => true) };
    const config = createConfig();

    const result = await confirmAction(config, "demo", "search", { q: "hello" }, ui as never);

    expect(result).toEqual({ approved: true });
    expect(ui.confirm).toHaveBeenCalledWith(
      "MCP action permission",
      expect.stringContaining('"search"'),
    );
    expect(ui.confirm).toHaveBeenCalledWith(
      "MCP action permission",
      expect.stringContaining('"demo"'),
    );
    expect(ui.confirm).toHaveBeenCalledWith(
      "MCP action permission",
      expect.stringContaining('{"q":"hello"}'),
    );
  });

  it("prompts without args when none are provided", async () => {
    const ui = { confirm: vi.fn(async () => true) };
    const config = createConfig();

    await confirmAction(config, "demo", "ping", undefined, ui as never);

    expect(ui.confirm).toHaveBeenCalledWith(
      "MCP action permission",
      'Run "ping" from MCP server "demo"?',
    );
  });

  it("refuses when the user declines", async () => {
    const ui = { confirm: vi.fn(async () => false) };
    const config = createConfig();

    const result = await confirmAction(config, "demo", "delete_all", {}, ui as never);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("declined");
  });

  it("refuses without UI when permission is ask", async () => {
    const config = createConfig();

    const result = await confirmAction(config, "demo", "delete_all", {}, undefined);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("actionPermission");
    expect(result.reason).toContain('"delete_all"');
  });

  it("runs without UI when a per-server override allows it", async () => {
    const config = createConfig({
      mcpServers: { demo: { command: "demo", actionPermission: "allow" } },
    });

    const result = await confirmAction(config, "demo", "delete_all", {}, undefined);

    expect(result).toEqual({ approved: true });
  });
});
