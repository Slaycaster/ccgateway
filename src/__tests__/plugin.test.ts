import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginLoader } from "../plugin.js";
import type {
  CcgCore,
  CcgPlugin,
  PluginFactory,
} from "../plugin.js";
import type { CcgConfig } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a minimal CcgCore stub for testing. */
function stubCore(config?: Partial<CcgConfig>): CcgCore {
  return {
    config: {
      agents: [],
      bindings: [],
      plugins: [],
      heartbeats: [],
      ...config,
    },
    agents: {
      getAgent: () => undefined,
      listAgents: () => [],
    },
    sessions: {
      getOrCreateSession: async () => "session-id",
    },
    router: {
      route: async () => "routed",
    },
    send: async () => {},
  };
}

/** Creates a mock plugin factory with optional spies. */
function mockPluginFactory(
  name: string,
  type: CcgPlugin["type"] = "gateway",
): { factory: PluginFactory; spies: { init: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } } {
  const spies = {
    init: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };

  const factory: PluginFactory = () => ({
    name,
    type,
    init: spies.init,
    start: spies.start,
    stop: spies.stop,
  });

  return { factory, spies };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PluginLoader", () => {
  let loader: PluginLoader;
  let core: CcgCore;

  beforeEach(() => {
    loader = new PluginLoader();
    core = stubCore();
  });

  // We need to intercept the dynamic import() inside PluginLoader.
  // We do this by monkey-patching the private importPlugin method.
  function injectMockImport(
    target: PluginLoader,
    factories: Record<string, PluginFactory>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (target as any).importPlugin = async (name: string) => {
      const factory = factories[name];
      if (!factory) {
        throw new Error(`Cannot find module '${name}'`);
      }
      return { default: factory };
    };
  }

  it("loads an enabled plugin and calls init", async () => {
    const { factory, spies } = mockPluginFactory("test-gw", "gateway");
    injectMockImport(loader, { "test-gw": factory });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [{ name: "test-gw", enabled: true, config: {} }],
      heartbeats: [],
    };

    await loader.loadPlugins(config, core);

    expect(spies.init).toHaveBeenCalledOnce();
    expect(spies.init).toHaveBeenCalledWith(core);
    expect(loader.getPlugins()).toHaveLength(1);
    expect(loader.getPlugin("test-gw")).toBeDefined();
    expect(loader.getPlugin("test-gw")!.name).toBe("test-gw");
  });

  it("skips disabled plugins", async () => {
    const { factory, spies } = mockPluginFactory("disabled-one");
    injectMockImport(loader, { "disabled-one": factory });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [{ name: "disabled-one", enabled: false, config: {} }],
      heartbeats: [],
    };

    await loader.loadPlugins(config, core);

    expect(spies.init).not.toHaveBeenCalled();
    expect(loader.getPlugins()).toHaveLength(0);
  });

  it("loads multiple plugins and filters by type", async () => {
    const { factory: gwFactory } = mockPluginFactory("discord", "gateway");
    const { factory: skillFactory } = mockPluginFactory("review", "skill");
    const { factory: toolFactory } = mockPluginFactory("bash", "tool");

    injectMockImport(loader, {
      discord: gwFactory,
      review: skillFactory,
      bash: toolFactory,
    });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [
        { name: "discord", enabled: true, config: {} },
        { name: "review", enabled: true, config: {} },
        { name: "bash", enabled: true, config: {} },
      ],
      heartbeats: [],
    };

    await loader.loadPlugins(config, core);

    expect(loader.getPlugins()).toHaveLength(3);
    expect(loader.getPluginsByType("gateway")).toHaveLength(1);
    expect(loader.getPluginsByType("gateway")[0].name).toBe("discord");
    expect(loader.getPluginsByType("skill")).toHaveLength(1);
    expect(loader.getPluginsByType("skill")[0].name).toBe("review");
    expect(loader.getPluginsByType("tool")).toHaveLength(1);
    expect(loader.getPluginsByType("tool")[0].name).toBe("bash");
  });

  it("calls start on all plugins during startAll", async () => {
    const { factory: f1, spies: s1 } = mockPluginFactory("a", "gateway");
    const { factory: f2, spies: s2 } = mockPluginFactory("b", "skill");

    injectMockImport(loader, { a: f1, b: f2 });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [
        { name: "a", enabled: true, config: {} },
        { name: "b", enabled: true, config: {} },
      ],
      heartbeats: [],
    };

    await loader.loadPlugins(config, core);
    await loader.startAll();

    expect(s1.start).toHaveBeenCalledOnce();
    expect(s2.start).toHaveBeenCalledOnce();
  });

  it("calls stop in reverse order during stopAll", async () => {
    const callOrder: string[] = [];

    const makeFactory = (name: string): PluginFactory => () => ({
      name,
      type: "gateway",
      init: async () => {},
      start: async () => {},
      stop: async () => {
        callOrder.push(name);
      },
    });

    injectMockImport(loader, {
      first: makeFactory("first"),
      second: makeFactory("second"),
      third: makeFactory("third"),
    });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [
        { name: "first", enabled: true, config: {} },
        { name: "second", enabled: true, config: {} },
        { name: "third", enabled: true, config: {} },
      ],
      heartbeats: [],
    };

    await loader.loadPlugins(config, core);
    await loader.stopAll();

    expect(callOrder).toEqual(["third", "second", "first"]);
  });

  it("full lifecycle: init -> start -> stop", async () => {
    const order: string[] = [];

    const factory: PluginFactory = () => ({
      name: "lifecycle",
      type: "tool",
      init: async () => {
        order.push("init");
      },
      start: async () => {
        order.push("start");
      },
      stop: async () => {
        order.push("stop");
      },
    });

    injectMockImport(loader, { lifecycle: factory });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [{ name: "lifecycle", enabled: true, config: {} }],
      heartbeats: [],
    };

    await loader.loadPlugins(config, core);
    await loader.startAll();
    await loader.stopAll();

    expect(order).toEqual(["init", "start", "stop"]);
  });

  it("throws when a plugin cannot be imported", async () => {
    // Don't inject any mocks — the import will fail
    injectMockImport(loader, {});

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [{ name: "nonexistent", enabled: true, config: {} }],
      heartbeats: [],
    };

    await expect(loader.loadPlugins(config, core)).rejects.toThrow(
      /Failed to load plugin "nonexistent"/,
    );
  });

  it("throws when module does not default-export a factory", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (loader as any).importPlugin = async () => ({
      default: "not-a-function",
    });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [{ name: "bad-export", enabled: true, config: {} }],
      heartbeats: [],
    };

    await expect(loader.loadPlugins(config, core)).rejects.toThrow(
      /does not default-export a factory function/,
    );
  });

  it("getPlugin returns undefined for unknown names", () => {
    expect(loader.getPlugin("nope")).toBeUndefined();
  });

  it("getPlugins returns a copy (not the internal array)", async () => {
    const { factory } = mockPluginFactory("x", "tool");
    injectMockImport(loader, { x: factory });

    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [{ name: "x", enabled: true, config: {} }],
      heartbeats: [],
    };

    await loader.loadPlugins(config, core);

    const list = loader.getPlugins();
    list.pop();
    expect(loader.getPlugins()).toHaveLength(1); // internal unchanged
  });
});
