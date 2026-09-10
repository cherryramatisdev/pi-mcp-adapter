import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

function createConnectedManager() {
  const connection = {
    status: "connected",
    client: {
      callTool: vi.fn(async () => ({
        isError: false,
        content: [{ type: "text", text: "ok" }],
      })),
    },
  };
  return {
    getConnection: vi.fn(() => connection),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
  };
}

function createState(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      settings: {},
      mcpServers: { demo: { command: "demo" } },
    },
    manager: createConnectedManager(),
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_search",
            originalName: "search",
            description: "Search demo records",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      ],
    ]),
    failureTracker: new Map(),
    completedUiSessions: [],
    ...overrides,
  } as any;
}

describe("proxy tool call permission gate", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("runs the tool when the user confirms (default ask mode)", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const ui = { confirm: vi.fn(async () => true) };
    const state = createState({ ui });

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(state.manager.getConnection("demo").client.callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { q: "hello" },
    });
    expect(result.content[0].text).toContain("ok");
  });

  it("does not run the tool when the user declines", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const ui = { confirm: vi.fn(async () => false) };
    const state = createState({ ui });

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");

    expect(state.manager.getConnection("demo").client.callTool).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ error: "action_denied", server: "demo", tool: "search" });
    expect(result.content[0].text).toContain("declined");
  });

  it("refuses in headless sessions when permission is ask", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const state = createState({ ui: undefined });

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(state.manager.getConnection("demo").client.callTool).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ error: "action_denied", server: "demo" });
    expect(result.content[0].text).toContain("actionPermission");
  });

  it("runs without prompting when the global setting is allow", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const ui = { confirm: vi.fn(async () => true) };
    const state = createState({
      config: {
        settings: { actionPermission: "allow" },
        mcpServers: { demo: { command: "demo" } },
      },
      ui,
    });

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("ok");
  });

  it("runs without prompting when the per-server override is allow", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const ui = { confirm: vi.fn(async () => true) };
    const state = createState({
      config: {
        settings: {},
        mcpServers: { demo: { command: "demo", actionPermission: "allow" } },
      },
      ui,
    });

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("ok");
  });
});

describe("direct tool permission gate", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("runs the tool when the user confirms (default ask mode)", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const ui = { confirm: vi.fn(async () => true) };
    const state = createState({ ui });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search" },
    );

    const result = await executor("id", { q: "hello" }, undefined, undefined, { ui } as any);

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(state.manager.getConnection("demo").client.callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { q: "hello" },
    });
    expect(result.content[0].text).toContain("ok");
  });

  it("does not run the tool when the user declines", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const ui = { confirm: vi.fn(async () => false) };
    const state = createState({ ui });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search" },
    );

    const result = await executor("id", {}, undefined, undefined, { ui } as any);

    expect(state.manager.getConnection("demo").client.callTool).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ error: "action_denied", server: "demo", tool: "search" });
    expect(result.content[0].text).toContain("declined");
  });

  it("runs without prompting when the global setting is allow", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const ui = { confirm: vi.fn(async () => true) };
    const state = createState({
      config: {
        settings: { actionPermission: "allow" },
        mcpServers: { demo: { command: "demo" } },
      },
      ui,
    });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search" },
    );

    const result = await executor("id", {}, undefined, undefined, { ui } as any);

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("ok");
  });
});
