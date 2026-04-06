import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageRouter } from "../router.js";
import type { AgentConfig, BindingConfig, IncomingMessage } from "../types.js";
import type { AgentRegistry } from "../agents.js";
import type { SessionManager } from "../sessions.js";
import type { ContextBuilder } from "../context.js";
import type { CCSpawner } from "../spawner.js";
import type { SpawnResult } from "../spawner.js";
import type { AsyncTaskWatcher } from "../async-watcher.js";

// ── Test data ─────────────────────────────────────────────────────────────

const AGENT_SALT: AgentConfig = {
  id: "salt",
  name: "Salt",
  emoji: "🧂",
  workspace: "/home/user/salt-workspace",
  model: "sonnet",
  skills: [],
  allowedTools: ["Read", "Write", "Bash"],
  maxConcurrentSessions: 3,
};

const BINDING_DISCORD: BindingConfig = {
  agent: "salt",
  gateway: "discord",
  channel: "123456",
  bot: "salt-bot",
};

const BINDING_SLACK: BindingConfig = {
  agent: "salt",
  gateway: "slack",
  channel: "C00SLACK",
  bot: "salt-slack",
};

const BINDING_PEPPER: BindingConfig = {
  agent: "pepper",
  gateway: "discord",
  channel: "789012",
  bot: "pepper-bot",
};

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    from: {
      gateway: "discord",
      channel: "123456",
      user: "Alice",
      userId: "u-alice",
      messageId: "msg-001",
    },
    to: { agent: "salt" },
    content: "Hello, Salt!",
    attachments: [],
    ...overrides,
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────

function createMockAgents(): AgentRegistry {
  return {
    getAgent: vi.fn((id: string) => (id === "salt" ? AGENT_SALT : undefined)),
    listAgents: vi.fn(() => [AGENT_SALT]),
    addAgent: vi.fn(),
    removeAgent: vi.fn(),
    validateWorkspace: vi.fn(),
  } as unknown as AgentRegistry;
}

function createMockSessions(): SessionManager {
  return {
    getOrCreateSession: vi.fn(
      (agentId: string, source: string, sourceId: string) =>
        `${agentId}:${source}:${sourceId}`,
    ),
    appendMessage: vi.fn(async () => {}),
    readHistory: vi.fn(async () => []),
    getWindowedHistory: vi.fn(async () => []),
    getSessionPath: vi.fn(),
    resetSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
  } as unknown as SessionManager;
}

function createMockContext(): ContextBuilder {
  return {
    build: vi.fn(async () => "--- Conversation History ---\n(empty)\n\n--- Memory ---\nToday's date: 2026-04-05"),
  } as unknown as ContextBuilder;
}

function createMockSpawner(result?: Partial<SpawnResult>): CCSpawner {
  const defaultResult: SpawnResult = {
    response: "I can help with that!",
    stderr: "",
    exitCode: 0,
    tokensEstimate: { in: 50, out: 10 },
  };
  return {
    spawn: vi.fn(async () => ({ ...defaultResult, ...result })),
    triage: vi.fn(async () => "sync" as const),
    spawnAsync: vi.fn(async () => ({
      sessionName: "ccg-salt-a3f2",
      taskDir: "/tmp/async-tasks/ccg-salt-a3f2",
    })),
  } as unknown as CCSpawner;
}

function createMockWatcher(): AsyncTaskWatcher {
  return {
    register: vi.fn(),
    listTasks: vi.fn(() => []),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => true),
  } as unknown as AsyncTaskWatcher;
}

// ── Setup ─────────────────────────────────────────────────────────────────

let agents: ReturnType<typeof createMockAgents>;
let sessions: ReturnType<typeof createMockSessions>;
let context: ReturnType<typeof createMockContext>;
let spawner: ReturnType<typeof createMockSpawner>;
let watcher: ReturnType<typeof createMockWatcher>;
let router: MessageRouter;

beforeEach(() => {
  agents = createMockAgents();
  sessions = createMockSessions();
  context = createMockContext();
  spawner = createMockSpawner();
  watcher = createMockWatcher();
  router = new MessageRouter(
    agents,
    sessions,
    context,
    spawner,
    [BINDING_DISCORD, BINDING_SLACK, BINDING_PEPPER],
    watcher,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── resolveAgent ──────────────────────────────────────────────────────────

describe("resolveAgent", () => {
  it("returns correct agent for matching binding", () => {
    expect(router.resolveAgent("discord", "123456")).toBe("salt");
  });

  it("returns correct agent for a different matching binding", () => {
    expect(router.resolveAgent("slack", "C00SLACK")).toBe("salt");
  });

  it("returns correct agent for a different agent binding", () => {
    expect(router.resolveAgent("discord", "789012")).toBe("pepper");
  });

  it("returns undefined for unmatched channel", () => {
    expect(router.resolveAgent("discord", "999999")).toBeUndefined();
  });

  it("returns undefined for unmatched gateway", () => {
    expect(router.resolveAgent("telegram", "123456")).toBeUndefined();
  });
});

// ── route — full pipeline ─────────────────────────────────────────────────

describe("route — full pipeline", () => {
  it("calls the full pipeline in order: session -> context -> spawn -> save response", async () => {
    const message = makeMessage();
    const callOrder: string[] = [];

    (sessions.getOrCreateSession as ReturnType<typeof vi.fn>).mockImplementation(
      (...args: any[]) => {
        callOrder.push("getOrCreateSession");
        return `${args[0]}:${args[1]}:${args[2]}`;
      },
    );

    (sessions.appendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("appendMessage");
    });

    (context.build as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("context.build");
      return "system prompt";
    });

    (spawner.spawn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("spawner.spawn");
      return { response: "Done!", exitCode: 0, tokensEstimate: { in: 10, out: 5 } };
    });

    await router.route(message);

    expect(callOrder).toEqual([
      "getOrCreateSession",
      "appendMessage",       // user message
      "context.build",
      "spawner.spawn",
      "appendMessage",       // assistant response
    ]);
  });

  it("appends both user message and assistant response to session", async () => {
    const message = makeMessage({ content: "What is 2+2?" });

    (spawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: "4",
      exitCode: 0,
      tokensEstimate: { in: 20, out: 5 },
    });

    await router.route(message);

    const appendCalls = (sessions.appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(appendCalls).toHaveLength(2);

    // First call: user message
    const [agentId1, sessionKey1, userMsg] = appendCalls[0];
    expect(agentId1).toBe("salt");
    expect(sessionKey1).toBe("salt:discord:123456");
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("What is 2+2?");
    expect(userMsg.source).toBe("discord");
    expect(userMsg.sourceUser).toBe("Alice");
    expect(userMsg.sourceMessageId).toBe("msg-001");

    // Second call: assistant message
    const [agentId2, sessionKey2, assistantMsg] = appendCalls[1];
    expect(agentId2).toBe("salt");
    expect(sessionKey2).toBe("salt:discord:123456");
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("4");
    expect(assistantMsg.tokens).toEqual({ in: 20, out: 5 });
  });

  it("returns the response text from spawner", async () => {
    const message = makeMessage();

    (spawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: "Here is the answer.",
      exitCode: 0,
      tokensEstimate: { in: 10, out: 5 },
    });

    const result = await router.route(message);
    expect(result).toBe("Here is the answer.");
  });

  it("passes correct options to spawner", async () => {
    const message = makeMessage({ content: "Fix the bug" });
    await router.route(message);

    expect(spawner.spawn).toHaveBeenCalledWith({
      workspace: AGENT_SALT.workspace,
      message: "Fix the bug",
      systemPrompt: expect.any(String),
      model: "sonnet",
      allowedTools: ["Read", "Write", "Bash"],
    });
  });

  it("passes per-agent timeoutMs to spawner when configured", async () => {
    const agentWithTimeout: AgentConfig = {
      ...AGENT_SALT,
      id: "slow-agent",
      timeoutMs: 600_000,
    };

    (agents.getAgent as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => (id === "slow-agent" ? agentWithTimeout : undefined),
    );

    const message = makeMessage({
      to: { agent: "slow-agent" },
    });

    await router.route(message);

    expect(spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  });

  it("does not pass timeoutMs to spawner when not configured on agent", async () => {
    await router.route(makeMessage());

    const spawnCall = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnCall).not.toHaveProperty("timeoutMs");
  });

  it("passes context.build result as systemPrompt to spawner", async () => {
    const customContext = "Custom context for this agent";
    (context.build as ReturnType<typeof vi.fn>).mockResolvedValue(customContext);

    await router.route(makeMessage());

    expect(spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: customContext }),
    );
  });
});

// ── route — error handling ────────────────────────────────────────────────

describe("route — error handling", () => {
  it("throws when agent not found", async () => {
    const message = makeMessage({
      to: { agent: "nonexistent" },
    });

    await expect(router.route(message)).rejects.toThrow(
      'Agent "nonexistent" not found in registry',
    );
  });

  it("does not call session or spawner when agent not found", async () => {
    const message = makeMessage({ to: { agent: "nonexistent" } });

    await expect(router.route(message)).rejects.toThrow();

    expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it("handles spawner failure: appends error to session and throws", async () => {
    (spawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: "Something went wrong",
      exitCode: 1,
      tokensEstimate: { in: 10, out: 5 },
    });

    const message = makeMessage();

    await expect(router.route(message)).rejects.toThrow(
      "Something went wrong",
    );

    // Should still have appended 2 messages: user + error
    const appendCalls = (sessions.appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(appendCalls).toHaveLength(2);

    const errorMsg = appendCalls[1][2];
    expect(errorMsg.role).toBe("assistant");
    expect(errorMsg.content).toContain("[error]");
    expect(errorMsg.content).toContain("Something went wrong");
  });

  it("handles timeout (exit code 124) with friendly error message", async () => {
    (spawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: "",
      exitCode: 124,
      tokensEstimate: { in: 10, out: 0 },
    });

    const message = makeMessage();

    await expect(router.route(message)).rejects.toThrow(
      "timed out",
    );

    const appendCalls = (sessions.appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const errorMsg = appendCalls[1][2];
    expect(errorMsg.content).toContain("[error]");
    expect(errorMsg.content).toContain("timed out");
    expect(errorMsg.content).toContain("timeoutMs");
  });
});

// ── addBinding ────────────────────────────────────────────────────────────

describe("addBinding", () => {
  it("adds a binding to the bindings list", () => {
    const newBinding: BindingConfig = {
      agent: "newagent",
      gateway: "telegram",
      channel: "tg-001",
      bot: "new-bot",
    };

    router.addBinding(newBinding);

    expect(router.resolveAgent("telegram", "tg-001")).toBe("newagent");
  });

  it("makes the new binding available via getBindingsForAgent", () => {
    const newBinding: BindingConfig = {
      agent: "newagent",
      gateway: "telegram",
      channel: "tg-001",
      bot: "new-bot",
    };

    router.addBinding(newBinding);

    const bindings = router.getBindingsForAgent("newagent");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual(newBinding);
  });
});

// ── getBindingsForAgent ───────────────────────────────────────────────────

describe("getBindingsForAgent", () => {
  it("returns filtered bindings for an agent", () => {
    const bindings = router.getBindingsForAgent("salt");
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toEqual(BINDING_DISCORD);
    expect(bindings[1]).toEqual(BINDING_SLACK);
  });

  it("returns only bindings for the specified agent", () => {
    const bindings = router.getBindingsForAgent("pepper");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual(BINDING_PEPPER);
  });

  it("returns empty array for agent with no bindings", () => {
    const bindings = router.getBindingsForAgent("nonexistent");
    expect(bindings).toEqual([]);
  });
});

// ── getPrimaryBinding ─────────────────────────────────────────────────────

describe("getPrimaryBinding", () => {
  it("returns the first binding for an agent", () => {
    const binding = router.getPrimaryBinding("salt");
    expect(binding).toEqual(BINDING_DISCORD);
  });

  it("returns undefined for agent with no bindings", () => {
    const binding = router.getPrimaryBinding("nonexistent");
    expect(binding).toBeUndefined();
  });
});

// ── route — async path ───────────────────────────────────────────────────

describe("route — async path", () => {
  it("dispatches to tmux when triage returns async", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("async");

    const message = makeMessage({ content: "Refactor the entire auth system" });
    const result = await router.route(message);

    expect(spawner.triage).toHaveBeenCalled();
    expect(spawner.spawnAsync).toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(watcher.register).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "ccg-salt-a3f2",
        agentId: "salt",
        channel: "123456",
      }),
    );
    expect(result).toContain("[async]");
    expect(result).toContain("ccg-salt-a3f2");
  });

  it("uses sync path when triage returns sync", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("sync");

    const message = makeMessage({ content: "What does this function do?" });
    await router.route(message);

    expect(spawner.triage).toHaveBeenCalled();
    expect(spawner.spawn).toHaveBeenCalled();
    expect(spawner.spawnAsync).not.toHaveBeenCalled();
  });

  it("passes correct options to spawnAsync", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("async");

    const message = makeMessage();
    await router.route(message);

    expect(spawner.spawnAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: AGENT_SALT.workspace,
        model: "sonnet",
        agentId: "salt",
      }),
    );
  });

  it("appends async placeholder to session history", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("async");

    const message = makeMessage();
    await router.route(message);

    const appendCalls = (sessions.appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(appendCalls).toHaveLength(2); // user + async placeholder
    const assistantMsg = appendCalls[1][2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toContain("[async]");
  });

  it("skips triage when no watcher is configured", async () => {
    // Create router without watcher
    const routerNoWatcher = new MessageRouter(
      agents,
      sessions,
      context,
      spawner,
      [BINDING_DISCORD, BINDING_SLACK, BINDING_PEPPER],
    );

    const message = makeMessage();
    await routerNoWatcher.route(message);

    expect(spawner.triage).not.toHaveBeenCalled();
    expect(spawner.spawn).toHaveBeenCalled();
  });
});
