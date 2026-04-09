import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock @slack/bolt ──────────────────────────────────────────────────────

// vi.hoisted ensures these are available when the hoisted vi.mock runs
const {
  mockAppStart,
  mockAppStop,
  mockPostMessage,
  mockChatUpdate,
  mockReactionsAdd,
  mockReactionsRemove,
  MockApp,
  getCapturedHandler,
  resetMockApp,
} = vi.hoisted(() => {
  const mockAppStart = vi.fn(async () => {});
  const mockAppStop = vi.fn(async () => {});
  const mockPostMessage = vi.fn(async () => ({ ts: "1234567890.999999" }));
  const mockChatUpdate = vi.fn(async () => ({}));
  const mockReactionsAdd = vi.fn(async () => ({}));
  const mockReactionsRemove = vi.fn(async () => ({}));

  let capturedHandler: ((args: any) => Promise<void>) | undefined;

  const MockApp = vi.fn();

  function resetMockApp() {
    capturedHandler = undefined;
    MockApp.mockReset();
    MockApp.mockImplementation(() => ({
      message: vi.fn((handler: any) => {
        capturedHandler = handler;
      }),
      start: mockAppStart,
      stop: mockAppStop,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    }));
  }

  // Set initial implementation
  resetMockApp();

  return {
    mockAppStart,
    mockAppStop,
    mockPostMessage,
    mockChatUpdate,
    mockReactionsAdd,
    mockReactionsRemove,
    MockApp,
    getCapturedHandler: () => capturedHandler!,
    resetMockApp,
  };
});

vi.mock("@slack/bolt", () => ({
  App: MockApp,
}));

// ── Import after mock ────────────────────────────────────────────────────

import createSlackGateway, {
  resolveToken,
  markdownToMrkdwn,
  splitMessage,
} from "../plugins/slack-gateway.js";
import type { CcgCore } from "../plugin.js";
import type { CcgConfig } from "../types.js";

// ── Test helpers ─────────────────────────────────────────────────────────

function stubCore(overrides: Partial<CcgCore> = {}): CcgCore {
  return {
    config: {
      agents: [],
      bindings: [],
      plugins: [],
    } as CcgConfig,
    agents: {
      getAgent: vi.fn((id: string) =>
        id === "salt"
          ? {
              id: "salt",
              name: "Salt",
              emoji: "🧂",
              workspace: "/ws",
              model: "sonnet",
              skills: [],
              allowedTools: [],
              maxConcurrentSessions: 3,
            }
          : undefined,
      ),
      listAgents: vi.fn(() => []),
    },
    sessions: {
      getOrCreateSession: vi.fn(
        (agentId: string, source: string, sourceId: string) =>
          `${agentId}:${source}:${sourceId}`,
      ),
    },
    router: {
      route: vi.fn(async () => "Agent response here"),
      resolveAgent: vi.fn((gateway: string, channelId: string) =>
        gateway === "slack" && channelId === "C001" ? "salt" : undefined,
      ),
      resolveAgentByBot: vi.fn(() => undefined),
    },
    send: vi.fn(async () => {}),
    ...overrides,
  };
}

function makePluginConfig() {
  return {
    bots: {
      "salt-bot": {
        token: "$SLACK_SALT_TOKEN",
        signingSecret: "$SLACK_SALT_SECRET",
        appToken: "$SLACK_SALT_APP_TOKEN",
      },
    },
    workspace: "test-workspace",
    allowedUsers: ["U_ALICE", "U_BOB"],
    commands: ["/new", "/reset", "/status"],
  };
}

// ── Tests: resolveToken ──────────────────────────────────────────────────

describe("resolveToken", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves $ENV_VAR from process.env", () => {
    process.env.MY_TOKEN = "xoxb-secret-123";
    expect(resolveToken("$MY_TOKEN")).toBe("xoxb-secret-123");
  });

  it("returns literal value when not starting with $", () => {
    expect(resolveToken("literal-token")).toBe("literal-token");
  });

  it("throws when env var is not set", () => {
    delete process.env.MISSING_VAR;
    expect(() => resolveToken("$MISSING_VAR")).toThrow(
      'Environment variable "MISSING_VAR" is not set',
    );
  });

  it("throws with descriptive message including the reference", () => {
    delete process.env.SOME_SECRET;
    expect(() => resolveToken("$SOME_SECRET")).toThrow(
      'referenced as "$SOME_SECRET"',
    );
  });
});

// ── Tests: markdownToMrkdwn ──────────────────────────────────────────────

describe("markdownToMrkdwn", () => {
  it("converts **bold** to *bold*", () => {
    expect(markdownToMrkdwn("This is **bold** text")).toBe(
      "This is *bold* text",
    );
  });

  it("converts *italic* to _italic_", () => {
    expect(markdownToMrkdwn("This is *italic* text")).toBe(
      "This is _italic_ text",
    );
  });

  it("converts ~~strikethrough~~ to ~strikethrough~", () => {
    expect(markdownToMrkdwn("This is ~~deleted~~ text")).toBe(
      "This is ~deleted~ text",
    );
  });

  it("converts [text](url) to <url|text>", () => {
    expect(markdownToMrkdwn("[click here](https://example.com)")).toBe(
      "<https://example.com|click here>",
    );
  });

  it("preserves inline code", () => {
    expect(markdownToMrkdwn("Use `**not bold**` here")).toBe(
      "Use `**not bold**` here",
    );
  });

  it("preserves code blocks", () => {
    const input = "Before\n```\n**not bold**\n```\nAfter **bold**";
    const result = markdownToMrkdwn(input);
    expect(result).toContain("```\n**not bold**\n```");
    expect(result).toContain("After *bold*");
  });

  it("handles multiple conversions in one string", () => {
    const input = "**bold** and *italic* and ~~strike~~";
    const result = markdownToMrkdwn(input);
    expect(result).toBe("*bold* and _italic_ and ~strike~");
  });

  it("passes through plain text unchanged", () => {
    expect(markdownToMrkdwn("plain text")).toBe("plain text");
  });
});

// ── Tests: splitMessage ──────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single-element array for short messages", () => {
    const result = splitMessage("short message", 100);
    expect(result).toEqual(["short message"]);
  });

  it("splits long messages at newlines", () => {
    const line = "a".repeat(40);
    const text = `${line}\n${line}\n${line}`;
    const result = splitMessage(text, 85);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(85);
    }
  });

  it("splits at spaces when no newline available", () => {
    const text = "word ".repeat(20).trim(); // ~99 chars
    const result = splitMessage(text, 50);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("hard-cuts when no good split point", () => {
    const text = "x".repeat(200);
    const result = splitMessage(text, 80);
    expect(result.length).toBe(3);
    expect(result[0].length).toBe(80);
    expect(result[1].length).toBe(80);
    expect(result[2].length).toBe(40);
  });
});

// ── Tests: plugin lifecycle ──────────────────────────────────────────────

describe("slack-gateway plugin", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SLACK_SALT_TOKEN = "xoxb-test-token";
    process.env.SLACK_SALT_SECRET = "test-signing-secret";
    process.env.SLACK_SALT_APP_TOKEN = "xapp-test-app-token";

    resetMockApp();
    mockAppStart.mockReset().mockImplementation(async () => {});
    mockAppStop.mockReset().mockImplementation(async () => {});
    mockPostMessage.mockReset().mockImplementation(async () => ({ ts: "1234567890.999999" }));
    mockChatUpdate.mockReset().mockImplementation(async () => ({}));
    mockReactionsAdd.mockReset().mockImplementation(async () => ({}));
    mockReactionsRemove.mockReset().mockImplementation(async () => ({}));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("has correct name and type", () => {
    const plugin = createSlackGateway(makePluginConfig());
    expect(plugin.name).toBe("slack-gateway");
    expect(plugin.type).toBe("gateway");
  });

  it("init resolves tokens from env vars", async () => {
    const plugin = createSlackGateway(makePluginConfig());
    const core = stubCore();
    await plugin.init(core);
    // If init succeeds without throwing, tokens were resolved
  });

  it("init throws when env var is missing", async () => {
    delete process.env.SLACK_SALT_TOKEN;
    const plugin = createSlackGateway(makePluginConfig());
    const core = stubCore();
    await expect(plugin.init(core)).rejects.toThrow(
      'Environment variable "SLACK_SALT_TOKEN" is not set',
    );
  });

  it("start creates App with socket mode and starts it", async () => {
    const plugin = createSlackGateway(makePluginConfig());
    const core = stubCore();
    await plugin.init(core);
    await plugin.start!();

    expect(MockApp).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "xoxb-test-token",
        signingSecret: "test-signing-secret",
        appToken: "xapp-test-app-token",
        socketMode: true,
      }),
    );
    expect(mockAppStart).toHaveBeenCalledOnce();
  });

  it("stop calls app.stop for all bots", async () => {
    const plugin = createSlackGateway(makePluginConfig());
    const core = stubCore();
    await plugin.init(core);
    await plugin.start!();
    await plugin.stop!();

    expect(mockAppStop).toHaveBeenCalledOnce();
  });
});

// ── Tests: message handling ──────────────────────────────────────────────

describe("slack-gateway message handling", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SLACK_SALT_TOKEN = "xoxb-test-token";
    process.env.SLACK_SALT_SECRET = "test-signing-secret";
    process.env.SLACK_SALT_APP_TOKEN = "xapp-test-app-token";

    resetMockApp();
    mockAppStart.mockReset().mockImplementation(async () => {});
    mockAppStop.mockReset().mockImplementation(async () => {});
    mockPostMessage.mockReset().mockImplementation(async () => ({ ts: "1234567890.999999" }));
    mockChatUpdate.mockReset().mockImplementation(async () => ({}));
    mockReactionsAdd.mockReset().mockImplementation(async () => ({}));
    mockReactionsRemove.mockReset().mockImplementation(async () => ({}));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  async function setupAndStart(coreOverrides: Partial<CcgCore> = {}) {
    const plugin = createSlackGateway(makePluginConfig());
    const core = stubCore(coreOverrides);
    await plugin.init(core);
    await plugin.start!();
    return { plugin, core };
  }

  function makeSlackMessage(overrides: Record<string, any> = {}) {
    return {
      user: "U_ALICE",
      text: "Hello Salt",
      channel: "C001",
      ts: "1234567890.123456",
      ...overrides,
    };
  }

  it("normalizes Slack message to IncomingMessage format", async () => {
    const { core } = await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage(),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(core.router.route).toHaveBeenCalledWith(
      expect.objectContaining({
        from: {
          gateway: "slack",
          channel: "C001",
          user: "U_ALICE",
          userId: "U_ALICE",
          messageId: "1234567890.123456",
        },
        to: { agent: "salt" },
        content: "Hello Salt",
        attachments: [],
      }),
      expect.any(Function), // onChunk streaming callback
    );
  });

  it("ignores messages from non-allowed users", async () => {
    const { core } = await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage({ user: "U_HACKER" }),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(core.router.route).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("ignores bot messages (subtype present)", async () => {
    const { core } = await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: { ...makeSlackMessage(), subtype: "bot_message" },
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(core.router.route).not.toHaveBeenCalled();
  });

  it("ignores messages with no bound agent", async () => {
    const { core } = await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage({ channel: "C_UNKNOWN" }),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(core.router.route).not.toHaveBeenCalled();
  });

  it("handles /status slash command", async () => {
    await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage({ text: "/status" }),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Salt"),
      }),
    );
  });

  it("handles /new slash command", async () => {
    await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage({ text: "/new" }),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Session reset"),
      }),
    );
  });

  it("handles /reset slash command", async () => {
    await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage({ text: "/reset" }),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Session reset"),
      }),
    );
  });

  it("replies in thread when message is in a thread", async () => {
    await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage({
        thread_ts: "1234567890.000001",
        ts: "1234567890.123456",
      }),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    // Initial "Thinking..." message should be posted in the thread
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1234567890.000001",
      }),
    );
  });

  it("uses message ts as thread_ts when not in a thread", async () => {
    await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage(),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    // Initial "Thinking..." message should use message ts as thread
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1234567890.123456",
      }),
    );
  });

  it("posts initial 'Thinking...' message before routing", async () => {
    await setupAndStart();
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage(),
      say,
      client: {
        chat: {
          postMessage: mockPostMessage,
          update: vi.fn(async () => ({})),
        },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C001",
        text: "Thinking...",
      }),
    );
  });

  it("sends error message when route fails", async () => {
    const { core } = await setupAndStart({
      router: {
        route: vi.fn(async () => {
          throw new Error("Agent exploded");
        }),
        resolveAgent: vi.fn((_g: string, _c: string) =>
          _g === "slack" && _c === "C001" ? "salt" : undefined,
        ),
        resolveAgentByBot: vi.fn(() => undefined),
      },
    } as any);
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage(),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    // Error should update the initial "Thinking..." message
    expect(mockChatUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Agent exploded"),
      }),
    );
  });

  it("converts markdown response to mrkdwn before sending", async () => {
    await setupAndStart({
      router: {
        route: vi.fn(async () => "This is **bold** and *italic*"),
        resolveAgent: vi.fn((_g: string, _c: string) =>
          _g === "slack" && _c === "C001" ? "salt" : undefined,
        ),
        resolveAgentByBot: vi.fn(() => undefined),
      },
    } as any);
    const say = vi.fn(async () => ({}));

    await getCapturedHandler()({
      message: makeSlackMessage(),
      say,
      client: {
        chat: { postMessage: mockPostMessage, update: mockChatUpdate },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
      },
    });

    // Final response updates the initial "Thinking..." message with mrkdwn
    expect(mockChatUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "This is *bold* and _italic_",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "This is *bold* and _italic_" },
          },
        ],
      }),
    );
  });
});
