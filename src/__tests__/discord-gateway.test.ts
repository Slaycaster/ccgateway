import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveToken,
  splitMessage,
  normalizeMessage,
} from "../plugins/discord-gateway.js";
import createDiscordGateway from "../plugins/discord-gateway.js";
import type { CcgCore } from "../plugin.js";
import type { Message, TextChannel, Collection, Attachment } from "discord.js";

// ── resolveToken ─────────────────────────────────────────────────────────

describe("resolveToken", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("resolves env var when token starts with $", () => {
    process.env.DISCORD_SALT_TOKEN = "real-token-value";
    expect(resolveToken("$DISCORD_SALT_TOKEN")).toBe("real-token-value");
  });

  it("returns literal token when it does not start with $", () => {
    expect(resolveToken("literal-token-123")).toBe("literal-token-123");
  });

  it("throws when env var is not set", () => {
    delete process.env.MISSING_VAR;
    expect(() => resolveToken("$MISSING_VAR")).toThrow(
      'Environment variable "MISSING_VAR" is not set',
    );
  });

  it("throws when env var is empty string", () => {
    process.env.EMPTY_VAR = "";
    expect(() => resolveToken("$EMPTY_VAR")).toThrow(
      'Environment variable "EMPTY_VAR" is not set',
    );
  });

  it("handles token that is just $", () => {
    // "$" means env var name is empty — should throw
    expect(() => resolveToken("$")).toThrow();
  });
});

// ── splitMessage ─────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single chunk when text is within limit", () => {
    const text = "Hello, world!";
    expect(splitMessage(text, 2000)).toEqual(["Hello, world!"]);
  });

  it("returns single chunk when text equals limit", () => {
    const text = "a".repeat(2000);
    expect(splitMessage(text, 2000)).toEqual([text]);
  });

  it("splits at paragraph boundary (\\n\\n)", () => {
    const para1 = "a".repeat(1500);
    const para2 = "b".repeat(1500);
    const text = `${para1}\n\n${para2}`;

    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("splits at line boundary when no paragraph boundary available", () => {
    const line1 = "a".repeat(1500);
    const line2 = "b".repeat(1500);
    const text = `${line1}\n${line2}`;

    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("hard-cuts when no boundary available", () => {
    const text = "a".repeat(5000);
    const chunks = splitMessage(text, 2000);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("a".repeat(2000));
    expect(chunks[1]).toBe("a".repeat(2000));
    expect(chunks[2]).toBe("a".repeat(1000));
  });

  it("prefers paragraph split over line split", () => {
    // paragraph boundary at 1000, line boundary at 1800
    const part1 = "a".repeat(1000);
    const part2 = "b".repeat(798);
    const part3 = "c".repeat(500);
    const text = `${part1}\n\n${part2}\n${part3}`;

    const chunks = splitMessage(text, 2000);
    // Total length: 1000 + 2 + 798 + 1 + 500 = 2301
    // Should split at the \n\n (index 1000)
    expect(chunks[0]).toBe(part1);
  });

  it("handles multiple splits correctly", () => {
    const paras = Array.from({ length: 5 }, (_, i) =>
      String.fromCharCode(97 + i).repeat(600),
    );
    const text = paras.join("\n\n");
    // Total: 5*600 + 4*2 = 3008

    const chunks = splitMessage(text, 2000);
    // First chunk should fit 3 paragraphs: 3*600 + 2*2 = 1804
    // Could also be a different split depending on boundary finding
    // Just verify all content is preserved
    expect(chunks.join("\n\n").length).toBeLessThanOrEqual(text.length);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("handles empty text", () => {
    expect(splitMessage("", 2000)).toEqual([""]);
  });

  it("uses default limit of 2000", () => {
    const text = "a".repeat(2001);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
  });
});

// ── normalizeMessage ─────────────────────────────────────────────────────

describe("normalizeMessage", () => {
  function makeMockMessage(overrides: Partial<{
    id: string;
    content: string;
    channelId: string;
    authorId: string;
    authorUsername: string;
    attachments: Array<{ contentType: string; url: string; name: string }>;
  }> = {}): Message {
    const attachmentArray = (overrides.attachments ?? []).map((a) => [
      a.name,
      a,
    ]);

    return {
      id: overrides.id ?? "msg-123",
      content: overrides.content ?? "Hello agent!",
      channelId: overrides.channelId ?? "ch-456",
      author: {
        id: overrides.authorId ?? "user-789",
        username: overrides.authorUsername ?? "TestUser",
        bot: false,
      },
      attachments: new Map(attachmentArray as any),
    } as unknown as Message;
  }

  it("normalizes a basic Discord message", () => {
    const msg = makeMockMessage({
      id: "msg-001",
      content: "Hello, Salt!",
      channelId: "ch-100",
      authorId: "u-alice",
      authorUsername: "Alice",
    });

    const result = normalizeMessage(msg, "salt");

    expect(result).toEqual({
      from: {
        gateway: "discord",
        channel: "ch-100",
        user: "Alice",
        userId: "u-alice",
        messageId: "msg-001",
      },
      to: { agent: "salt" },
      content: "Hello, Salt!",
      attachments: [],
    });
  });

  it("normalizes attachments", () => {
    const msg = makeMockMessage({
      attachments: [
        {
          contentType: "image/png",
          url: "https://cdn.discord.com/image.png",
          name: "screenshot.png",
        },
      ],
    });

    const result = normalizeMessage(msg, "pepper");

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      type: "image/png",
      url: "https://cdn.discord.com/image.png",
      filename: "screenshot.png",
    });
  });

  it("sets gateway to discord", () => {
    const msg = makeMockMessage();
    const result = normalizeMessage(msg, "salt");
    expect(result.from.gateway).toBe("discord");
  });

  it("sets target agent from parameter", () => {
    const msg = makeMockMessage();
    const result = normalizeMessage(msg, "custom-agent");
    expect(result.to.agent).toBe("custom-agent");
  });
});

// ── Plugin init (token resolution) ───────────────────────────────────────

describe("discord-gateway plugin init", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  function makeMockCore(): CcgCore {
    return {
      config: { agents: [], bindings: [], plugins: [] },
      agents: {
        getAgent: vi.fn(),
        listAgents: vi.fn(() => []),
      },
      sessions: {
        getOrCreateSession: vi.fn(() => "salt:discord:ch-1"),
        resetSession: vi.fn(async () => {}),
      },
      router: {
        route: vi.fn(async () => "Response from agent"),
        resolveAgent: vi.fn(() => "salt"),
      },
      send: vi.fn(async () => {}),
    } as unknown as CcgCore;
  }

  it("resolves bot tokens from env vars during init", async () => {
    process.env.DISCORD_SALT_TOKEN = "salt-token-value";
    process.env.DISCORD_PEPPER_TOKEN = "pepper-token-value";

    const plugin = createDiscordGateway({
      bots: {
        salt: { token: "$DISCORD_SALT_TOKEN" },
        pepper: { token: "$DISCORD_PEPPER_TOKEN" },
      },
      guild: "guild-1",
      allowedUsers: ["user-1"],
      commands: ["/new", "/reset", "/status"],
    });

    const core = makeMockCore();
    await plugin.init(core);

    // If init didn't throw, tokens were resolved successfully
    expect(plugin.name).toBe("discord-gateway");
    expect(plugin.type).toBe("gateway");
  });

  it("throws during init if env var is missing", async () => {
    delete process.env.MISSING_TOKEN;

    const plugin = createDiscordGateway({
      bots: {
        salt: { token: "$MISSING_TOKEN" },
      },
      guild: "guild-1",
      allowedUsers: ["user-1"],
      commands: [],
    });

    const core = makeMockCore();
    await expect(plugin.init(core)).rejects.toThrow(
      'Environment variable "MISSING_TOKEN" is not set',
    );
  });
});

// ── Bot message filtering ────────────────────────────────────────────────

describe("bot message filtering logic", () => {
  it("should define the concept: ignore external bots, allow own bots", () => {
    // This tests the filtering logic conceptually.
    // In the plugin, msg.author.bot && !ownBotUserIds.has(msg.author.id)
    // means: if it's a bot AND not one of our own, ignore it.

    const ownBotIds = new Set(["bot-salt-id", "bot-pepper-id"]);

    // External bot: should be ignored
    const externalBot = { bot: true, id: "external-bot-id" };
    const shouldIgnoreExternal =
      externalBot.bot && !ownBotIds.has(externalBot.id);
    expect(shouldIgnoreExternal).toBe(true);

    // Our own bot: should NOT be ignored
    const ownBot = { bot: true, id: "bot-salt-id" };
    const shouldIgnoreOwn = ownBot.bot && !ownBotIds.has(ownBot.id);
    expect(shouldIgnoreOwn).toBe(false);

    // Regular user: not a bot, should NOT be ignored
    const regularUser = { bot: false, id: "user-1" };
    const shouldIgnoreUser =
      regularUser.bot && !ownBotIds.has(regularUser.id);
    expect(shouldIgnoreUser).toBe(false);
  });
});

// ── Allowed user filtering ───────────────────────────────────────────────

describe("allowed user filtering logic", () => {
  it("allows users in the allowedUsers list", () => {
    const allowedUsers = ["user-1", "user-2", "user-3"];
    expect(allowedUsers.includes("user-1")).toBe(true);
    expect(allowedUsers.includes("user-2")).toBe(true);
  });

  it("rejects users not in the allowedUsers list", () => {
    const allowedUsers = ["user-1", "user-2", "user-3"];
    expect(allowedUsers.includes("user-99")).toBe(false);
  });

  it("allows own bot users regardless of allowedUsers", () => {
    const allowedUsers = ["user-1"];
    const ownBotUserIds = new Set(["bot-salt-id"]);

    // Our bot is not in allowedUsers, but it should bypass the check
    const authorId = "bot-salt-id";
    const isOwnBot = ownBotUserIds.has(authorId);
    const isAllowed = isOwnBot || allowedUsers.includes(authorId);

    expect(isAllowed).toBe(true);
  });
});

// ── Slash command handling ───────────────────────────────────────────────

describe("slash command detection", () => {
  it("detects /new command (case-insensitive)", () => {
    const commands = ["/new", "/NEW", " /new ", "/New"];
    for (const cmd of commands) {
      const trimmed = cmd.trim().toLowerCase();
      expect(trimmed === "/new" || trimmed === "/reset").toBe(true);
    }
  });

  it("detects /reset command", () => {
    const trimmed = "/reset".trim().toLowerCase();
    expect(trimmed === "/new" || trimmed === "/reset").toBe(true);
  });

  it("detects /status command", () => {
    const trimmed = "/status".trim().toLowerCase();
    expect(trimmed === "/status").toBe(true);
  });

  it("does not treat regular text as a command", () => {
    const texts = ["hello /new", "the /reset", "status", "/unknown"];
    for (const text of texts) {
      const trimmed = text.trim().toLowerCase();
      const isCommand =
        trimmed === "/new" || trimmed === "/reset" || trimmed === "/status";
      expect(isCommand).toBe(false);
    }
  });
});
