import { describe, expect, it, vi } from "vitest";
import { confirmAction, getActionPermission, onPermissionAsk } from "../action-permission.ts";
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

  it("approves read-only actions without prompting in ask mode", async () => {
    const ui = { confirm: vi.fn(async () => true) };
    const config = createConfig();

    const result = await confirmAction(config, "demo", "list_files", {}, ui as never, undefined, true);

    expect(result).toEqual({ approved: true });
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("approves read-only actions in headless ask mode", async () => {
    const config = createConfig();

    const result = await confirmAction(config, "demo", "list_files", {}, undefined, undefined, true);

    expect(result).toEqual({ approved: true });
  });

  it("still confirms mutating actions when a UI is present", async () => {
    const ui = { confirm: vi.fn(async () => true) };
    const config = createConfig();

    const result = await confirmAction(config, "demo", "delete_all", {}, ui as never, undefined, false);

    expect(ui.confirm).toHaveBeenCalled();
    expect(result).toEqual({ approved: true });
  });

  it("serializes concurrent prompts so parallel calls cannot clobber the dialog", async () => {
    const resolvers: Array<(value: boolean) => void> = [];
    let active = 0;
    let maxActive = 0;
    const ui = {
      confirm: vi.fn(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<boolean>((resolve) => {
          resolvers.push((value) => {
            active -= 1;
            resolve(value);
          });
        });
      }),
    };
    const config = createConfig();

    const first = confirmAction(config, "demo", "one", {}, ui as never);
    const second = confirmAction(config, "demo", "two", {}, ui as never);

    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1));
    expect(resolvers).toHaveLength(1);

    resolvers[0](true);
    await expect(first).resolves.toEqual({ approved: true });

    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(2));
    expect(resolvers).toHaveLength(2);

    resolvers[1](true);
    await expect(second).resolves.toEqual({ approved: true });
    expect(maxActive).toBe(1);
  });

  it("drops a queued prompt when its call is aborted", async () => {
    const resolvers: Array<(value: boolean) => void> = [];
    const ui = {
      confirm: vi.fn(() => new Promise<boolean>((resolve) => { resolvers.push(resolve); })),
    };
    const config = createConfig();
    const controller = new AbortController();

    const first = confirmAction(config, "demo", "one", {}, ui as never);
    const second = confirmAction(config, "demo", "two", {}, ui as never, controller.signal);

    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(second).resolves.toMatchObject({ approved: false });
    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(1);

    resolvers[0](true);
    await expect(first).resolves.toEqual({ approved: true });
  });

  it("dismisses the open dialog and reports cancellation when aborted", async () => {
    const ui = {
      confirm: vi.fn((_title: string, _message: string, opts?: { signal?: AbortSignal }) =>
        new Promise<boolean>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
        })),
    };
    const config = createConfig();
    const controller = new AbortController();

    const promise = confirmAction(config, "demo", "one", {}, ui as never, controller.signal);
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1));
    controller.abort();

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("cancelled");
    expect(ui.confirm).toHaveBeenCalledWith("MCP action permission", expect.any(String), {
      signal: controller.signal,
    });
  });

  it("emits a permission-ask event when a confirmation dialog is shown", async () => {
    const seen: Array<{ serverName: string; toolName: string }> = [];
    const off = onPermissionAsk((detail) => seen.push(detail));
    try {
      const ui = { confirm: vi.fn(async () => true) };
      const config = createConfig();

      await confirmAction(config, "demo", "delete_all", {}, ui as never);

      expect(seen).toEqual([{ serverName: "demo", toolName: "delete_all" }]);
    } finally {
      off();
    }
  });

  it("does not emit for read-only, allow-mode, or headless-refused actions", async () => {
    const seen: Array<{ serverName: string; toolName: string }> = [];
    const off = onPermissionAsk((detail) => seen.push(detail));
    try {
      const ui = { confirm: vi.fn(async () => true) };
      const allowConfig = createConfig({ settings: { actionPermission: "allow" } });
      const askConfig = createConfig();

      await confirmAction(allowConfig, "demo", "delete_all", {}, ui as never);
      await confirmAction(askConfig, "demo", "list_files", {}, ui as never, undefined, true);
      await confirmAction(askConfig, "demo", "delete_all", {}, undefined);

      expect(seen).toEqual([]);
    } finally {
      off();
    }
  });

  it("is not broken by a failing listener", async () => {
    const off = onPermissionAsk(() => {
      throw new Error("boom");
    });
    try {
      const ui = { confirm: vi.fn(async () => true) };
      const config = createConfig();

      const result = await confirmAction(config, "demo", "delete_all", {}, ui as never);

      expect(result).toEqual({ approved: true });
    } finally {
      off();
    }
  });
});
