import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CrossAgentMessenger } from "../messaging.js";
import type { InboxMessage } from "../messaging.js";
import type { AgentRegistry } from "../agents.js";
import type { PluginLoader } from "../plugin.js";
import type { AgentConfig, BindingConfig } from "../config.js";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test data ────────────────────────────────────────────────────────────

const AGENT_PEPPER: AgentConfig = {
  id: "pepper",
  name: "Pepper",
  emoji: "",
  workspace: "/home/user/pepper-workspace",
  model: "sonnet",
  skills: [],
  allowedTools: ["Read", "Write"],
  maxConcurrentSessions: 3,
};

const AGENT_SALT: AgentConfig = {
  id: "salt",
  name: "Salt",
  emoji: "",
  workspace: "/home/user/salt-workspace",
  model: "sonnet",
  skills: [],
  allowedTools: ["Read", "Write", "Bash"],
  maxConcurrentSessions: 3,
};

const AGENT_CUMIN: AgentConfig = {
  id: "cumin",
  name: "Cumin",
  emoji: "",
  workspace: "/home/user/cumin-workspace",
  model: "sonnet",
  skills: [],
  allowedTools: ["Read"],
  maxConcurrentSessions: 1,
};

const BINDING_PEPPER_DISCORD: BindingConfig = {
  agent: "pepper",
  gateway: "discord",
  channel: "ch-pepper",
  bot: "pepper-bot",
};

const BINDING_SALT_DISCORD: BindingConfig = {
  agent: "salt",
  gateway: "discord",
  channel: "ch-salt",
  bot: "salt-bot",
};

const BINDINGS: BindingConfig[] = [BINDING_PEPPER_DISCORD, BINDING_SALT_DISCORD];

// ── Mocks ────────────────────────────────────────────────────────────────

function createMockAgents(): AgentRegistry {
  const agents = new Map<string, AgentConfig>([
    ["pepper", AGENT_PEPPER],
    ["salt", AGENT_SALT],
    ["cumin", AGENT_CUMIN],
  ]);

  return {
    getAgent: vi.fn((id: string) => agents.get(id)),
    listAgents: vi.fn(() => Array.from(agents.values())),
    addAgent: vi.fn(),
    removeAgent: vi.fn(),
    validateWorkspace: vi.fn(),
  } as unknown as AgentRegistry;
}

function createMockSendToChannel() {
  return vi.fn(async () => {});
}

function createMockPluginLoader(
  sendToChannel: ReturnType<typeof vi.fn>,
  gatewayName = "discord-gateway",
): PluginLoader {
  const mockGatewayPlugin = {
    name: gatewayName,
    type: "gateway" as const,
    init: vi.fn(),
    sendToChannel,
  };

  return {
    getPlugins: vi.fn(() => [mockGatewayPlugin]),
    getPluginsByType: vi.fn((type: string) =>
      type === "gateway" ? [mockGatewayPlugin] : [],
    ),
    getPlugin: vi.fn((name: string) =>
      name === gatewayName ? mockGatewayPlugin : undefined,
    ),
    loadPlugins: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as PluginLoader;
}

function createMockPluginLoaderNoGateway(): PluginLoader {
  return {
    getPlugins: vi.fn(() => []),
    getPluginsByType: vi.fn(() => []),
    getPlugin: vi.fn(() => undefined),
    loadPlugins: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as PluginLoader;
}

// ── Setup ────────────────────────────────────────────────────────────────

let tmpHome: string;
let agents: ReturnType<typeof createMockAgents>;
let sendToChannel: ReturnType<typeof vi.fn>;
let plugins: PluginLoader;
let messenger: CrossAgentMessenger;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "ccg-messaging-test-"));
  agents = createMockAgents();
  sendToChannel = createMockSendToChannel();
  plugins = createMockPluginLoader(sendToChannel);
  messenger = new CrossAgentMessenger(agents, BINDINGS, plugins, tmpHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpHome, { recursive: true, force: true });
});

// ── send — channel-native ────────────────────────────────────────────────

describe("send — channel-native messaging", () => {
  it("calls sendToChannel on the correct plugin with target binding", async () => {
    await messenger.send("pepper", "Hello Pepper!");

    expect(sendToChannel).toHaveBeenCalledWith(
      "ch-pepper",
      "pepper-bot",
      "Hello Pepper!",
    );
  });

  it("uses sender's bot ID when fromAgentId is provided", async () => {
    await messenger.send("pepper", "RCA done for NHD-10763", "salt");

    expect(sendToChannel).toHaveBeenCalledWith(
      "ch-pepper",
      "salt-bot",
      "RCA done for NHD-10763",
    );
  });

  it("falls back to target bot when sender has no binding on same gateway", async () => {
    // cumin has no discord binding, so should fall back to pepper's bot
    await messenger.send("pepper", "Hello from Cumin", "cumin");

    expect(sendToChannel).toHaveBeenCalledWith(
      "ch-pepper",
      "pepper-bot",
      "Hello from Cumin",
    );
  });
});

// ── send — inbox fallback ────────────────────────────────────────────────

describe("send — inbox fallback", () => {
  it("falls back to inbox when agent has no binding", async () => {
    // cumin has no binding in BINDINGS array
    await messenger.send("cumin", "Hey cumin", "salt");

    const inboxPath = messenger.getInboxPath("cumin");
    const raw = await readFile(inboxPath, "utf-8");
    const msg = JSON.parse(raw.trim()) as InboxMessage;

    expect(msg.from).toBe("salt");
    expect(msg.content).toBe("Hey cumin");
    expect(msg.read).toBe(false);
  });

  it("falls back to inbox when no gateway plugin and no router", async () => {
    // Agent with no binding → goes straight to inbox
    const noPlugins = createMockPluginLoaderNoGateway();
    const msg2 = new CrossAgentMessenger(agents, [], noPlugins, tmpHome);

    await msg2.send("pepper", "No plugin available", "salt");

    const inboxPath = msg2.getInboxPath("pepper");
    const raw = await readFile(inboxPath, "utf-8");
    const parsed = JSON.parse(raw.trim()) as InboxMessage;

    expect(parsed.from).toBe("salt");
    expect(parsed.content).toBe("No plugin available");
  });

  it("throws when target agent does not exist", async () => {
    await expect(
      messenger.send("nonexistent", "Hello"),
    ).rejects.toThrow('Agent "nonexistent" not found');
  });
});

// ── sendToInbox ──────────────────────────────────────────────────────────

describe("sendToInbox", () => {
  it("creates directory and appends to JSONL file", async () => {
    await messenger.sendToInbox("pepper", "First message", "salt");

    const inboxPath = messenger.getInboxPath("pepper");
    const raw = await readFile(inboxPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    expect(lines).toHaveLength(1);

    const msg = JSON.parse(lines[0]) as InboxMessage;
    expect(msg.from).toBe("salt");
    expect(msg.content).toBe("First message");
    expect(msg.ts).toBeGreaterThan(0);
    expect(msg.read).toBe(false);
  });

  it("appends multiple messages to the same file", async () => {
    await messenger.sendToInbox("pepper", "Message 1", "salt");
    await messenger.sendToInbox("pepper", "Message 2", "cumin");

    const inboxPath = messenger.getInboxPath("pepper");
    const raw = await readFile(inboxPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    expect(lines).toHaveLength(2);

    const msg1 = JSON.parse(lines[0]) as InboxMessage;
    const msg2 = JSON.parse(lines[1]) as InboxMessage;

    expect(msg1.content).toBe("Message 1");
    expect(msg1.from).toBe("salt");
    expect(msg2.content).toBe("Message 2");
    expect(msg2.from).toBe("cumin");
  });

  it("defaults from to 'system' when no fromAgentId", async () => {
    await messenger.sendToInbox("pepper", "System notification");

    const inboxPath = messenger.getInboxPath("pepper");
    const raw = await readFile(inboxPath, "utf-8");
    const msg = JSON.parse(raw.trim()) as InboxMessage;

    expect(msg.from).toBe("system");
  });
});

// ── readInbox ────────────────────────────────────────────────────────────

describe("readInbox", () => {
  it("returns empty array for non-existent inbox", async () => {
    const messages = await messenger.readInbox("pepper");
    expect(messages).toEqual([]);
  });

  it("returns only unread messages", async () => {
    // Write a mix of read and unread messages
    const inboxPath = messenger.getInboxPath("pepper");
    const dir = join(tmpHome, "agents", "pepper");
    await mkdir(dir, { recursive: true });

    const msgs = [
      { from: "salt", content: "Read msg", ts: 1000, read: true },
      { from: "cumin", content: "Unread msg 1", ts: 2000, read: false },
      { from: "salt", content: "Unread msg 2", ts: 3000, read: false },
    ];
    const content = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(inboxPath, content, "utf-8");

    const unread = await messenger.readInbox("pepper");

    expect(unread).toHaveLength(2);
    expect(unread[0].content).toBe("Unread msg 1");
    expect(unread[1].content).toBe("Unread msg 2");
  });

  it("returns empty array for inbox with only read messages", async () => {
    const inboxPath = messenger.getInboxPath("pepper");
    const dir = join(tmpHome, "agents", "pepper");
    await mkdir(dir, { recursive: true });

    const msgs = [
      { from: "salt", content: "Already read", ts: 1000, read: true },
    ];
    const content = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(inboxPath, content, "utf-8");

    const unread = await messenger.readInbox("pepper");
    expect(unread).toEqual([]);
  });

  it("returns empty array for empty inbox file", async () => {
    const inboxPath = messenger.getInboxPath("pepper");
    const dir = join(tmpHome, "agents", "pepper");
    await mkdir(dir, { recursive: true });
    await writeFile(inboxPath, "", "utf-8");

    const unread = await messenger.readInbox("pepper");
    expect(unread).toEqual([]);
  });
});

// ── markInboxRead ────────────────────────────────────────────────────────

describe("markInboxRead", () => {
  it("marks all messages as read", async () => {
    // Write unread messages
    await messenger.sendToInbox("pepper", "Msg 1", "salt");
    await messenger.sendToInbox("pepper", "Msg 2", "cumin");

    // Verify they are unread
    let unread = await messenger.readInbox("pepper");
    expect(unread).toHaveLength(2);

    // Mark as read
    await messenger.markInboxRead("pepper");

    // Verify they are now read
    unread = await messenger.readInbox("pepper");
    expect(unread).toEqual([]);

    // Verify the file still has the messages (just marked read)
    const inboxPath = messenger.getInboxPath("pepper");
    const raw = await readFile(inboxPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const msg = JSON.parse(line) as InboxMessage;
      expect(msg.read).toBe(true);
    }
  });

  it("is a no-op for non-existent inbox", async () => {
    // Should not throw
    await messenger.markInboxRead("nonexistent");
  });

  it("is a no-op for empty inbox file", async () => {
    const dir = join(tmpHome, "agents", "pepper");
    await mkdir(dir, { recursive: true });
    await writeFile(messenger.getInboxPath("pepper"), "", "utf-8");

    // Should not throw
    await messenger.markInboxRead("pepper");
  });
});

// ── getInboxPath ─────────────────────────────────────────────────────────

describe("getInboxPath", () => {
  it("returns correct path", () => {
    const path = messenger.getInboxPath("pepper");
    expect(path).toBe(join(tmpHome, "agents", "pepper", "inbox.jsonl"));
  });

  it("returns correct path for different agent", () => {
    const path = messenger.getInboxPath("salt");
    expect(path).toBe(join(tmpHome, "agents", "salt", "inbox.jsonl"));
  });
});
