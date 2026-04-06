import { Client, GatewayIntentBits, type Message, type TextChannel } from "discord.js";
import type { CcgPlugin, CcgCore } from "../plugin.js";
import type { IncomingMessage } from "../types.js";
import { logger } from "../logger.js";

// ── Config interfaces ─────────────────────────────────────────────────────

interface DiscordBotConfig {
  token: string; // env var reference like "$DISCORD_SALT_TOKEN"
}

interface DiscordGatewayConfig {
  bots: Record<string, DiscordBotConfig>; // botId -> config
  guild: string;
  allowedUsers: string[];
  commands: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

/** Minimum interval between Discord message edits (rate-limit safe). */
const EDIT_THROTTLE_MS = 800;

/** Discord message character limit. */
const DISCORD_CHAR_LIMIT = 2000;

// ── Helpers (exported for testing) ────────────────────────────────────────

/**
 * Resolve a token value. If it starts with "$", treat it as an env var name.
 * Throws if the env var is not set.
 */
export function resolveToken(token: string): string {
  if (token.startsWith("$")) {
    const envName = token.slice(1);
    const value = process.env[envName];
    if (!value) {
      throw new Error(
        `Environment variable "${envName}" is not set (referenced by token "${token}")`,
      );
    }
    return value;
  }
  return token;
}

/**
 * Smart message splitter for Discord's 2000-char limit.
 * Prefers splitting at paragraph boundaries (\n\n), then line boundaries (\n),
 * then hard-cuts at the limit.
 *
 * Preserves code block fences across splits.
 */
export function splitMessage(text: string, limit: number = 2000): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try splitting at paragraph boundary (\n\n)
    let splitIdx = remaining.lastIndexOf("\n\n", limit);
    if (splitIdx > 0) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 2); // skip the \n\n
      continue;
    }

    // Try splitting at line boundary (\n)
    splitIdx = remaining.lastIndexOf("\n", limit);
    if (splitIdx > 0) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1); // skip the \n
      continue;
    }

    // Hard cut at limit
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }

  return chunks;
}

/**
 * Normalize a Discord message into an IncomingMessage.
 */
export function normalizeMessage(
  msg: Message,
  agentId: string,
): IncomingMessage {
  return {
    from: {
      gateway: "discord",
      channel: msg.channelId,
      user: msg.author.username,
      userId: msg.author.id,
      messageId: msg.id,
    },
    to: { agent: agentId },
    content: msg.content,
    attachments: Array.from(msg.attachments.values()).map((a) => ({
      type: a.contentType ?? "application/octet-stream",
      url: a.url,
      filename: a.name ?? undefined,
    })),
  };
}

// ── Plugin factory ────────────────────────────────────────────────────────

export default function createDiscordGateway(
  pluginConfig: DiscordGatewayConfig,
): CcgPlugin {
  let core: CcgCore;
  const clients = new Map<string, Client>();
  const resolvedTokens = new Map<string, string>();

  // Track our own bot user IDs so we can distinguish "our bots" from "other bots"
  const ownBotUserIds = new Set<string>();

  // Per-channel message queue — prevents concurrent spawns for the same channel.
  // When a message is being processed, subsequent messages queue behind it.
  const channelLocks = new Map<string, Promise<void>>();

  // Message deduplication — Discord gateway can replay events after reconnection.
  // Track recently seen message IDs to prevent processing the same message twice.
  const seenMessages = new Set<string>();

  const plugin: CcgPlugin & Record<string, unknown> = {
    name: "discord-gateway",
    type: "gateway",

    async init(coreRef: CcgCore): Promise<void> {
      core = coreRef;

      // Resolve all bot tokens from env vars
      for (const [botId, botConfig] of Object.entries(pluginConfig.bots)) {
        const token = resolveToken(botConfig.token);
        resolvedTokens.set(botId, token);
      }
    },

    async start(): Promise<void> {
      for (const [botId, token] of Array.from(resolvedTokens.entries())) {
        const client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
          ],
        });

        clients.set(botId, client);

        client.on("ready", () => {
          if (client.user) {
            ownBotUserIds.add(client.user.id);
            logger.info(
              `discord-gateway: bot "${botId}" connected as ${client.user.tag}`,
            );
            // Log which bound channels this bot can see
            const botBindings = core.config.bindings.filter(
              (b) => b.gateway === "discord" && b.bot === botId,
            );
            for (const b of botBindings) {
              const ch = client.channels.cache.get(b.channel);
              logger.info(
                `discord-gateway: bot "${botId}" binding ${b.channel} (agent: ${b.agent}) — ${ch ? "visible" : "NOT VISIBLE"}`,
              );
            }
          }
        });

        client.on("messageCreate", async (msg: Message) => {
          // Deduplicate at the earliest point — before enqueue.
          // Discord gateway can deliver the same event multiple times per bot.
          // Key includes botId so different bots can still process the same message.
          const dedupKey = `${botId}:${msg.id}`;
          if (seenMessages.has(dedupKey)) return;
          seenMessages.add(dedupKey);
          if (seenMessages.size > 5000) {
            const all = [...seenMessages];
            seenMessages.clear();
            for (const id of all.slice(-2500)) seenMessages.add(id);
          }

          try {
            await enqueueMessage(msg, botId);
          } catch (err) {
            const errMsg =
              err instanceof Error ? err.message : String(err);
            logger.error(
              `discord-gateway: error handling message ${msg.id}: ${errMsg}`,
            );
          }
        });

        await client.login(token);
      }
    },

    async stop(): Promise<void> {
      for (const [botId, client] of Array.from(clients.entries())) {
        logger.info(`discord-gateway: disconnecting bot "${botId}"`);
        client.destroy();
      }
      clients.clear();
      ownBotUserIds.clear();
    },
  };

  // Attach sendToChannel for cross-agent messaging (not part of CcgPlugin interface)
  plugin.sendToChannel = async (
    channelId: string,
    botId: string,
    content: string,
  ): Promise<void> => {
    const client = clients.get(botId);
    if (!client) {
      throw new Error(`Bot "${botId}" not found in discord-gateway`);
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) {
      throw new Error(
        `Channel "${channelId}" not found or not a text channel`,
      );
    }

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await (channel as TextChannel).send(chunk);
    }
  };

  return plugin;

  // ── Per-channel queue — serialize messages so only one spawns at a time ──

  async function enqueueMessage(msg: Message, receivingBotId: string): Promise<void> {
    const key = `${receivingBotId}:${msg.channelId}`;
    const prev = channelLocks.get(key) ?? Promise.resolve();

    const current = prev.then(
      () => handleMessage(msg, receivingBotId),
      () => handleMessage(msg, receivingBotId), // run even if prev rejected
    );

    channelLocks.set(key, current);

    // Clean up after completion to avoid memory leak
    current.finally(() => {
      if (channelLocks.get(key) === current) {
        channelLocks.delete(key);
      }
    });

    return current;
  }

  // ── Internal message handler ──────────────────────────────────────────

  async function handleMessage(msg: Message, receivingBotId: string): Promise<void> {
    logger.info(
      `discord-gateway: bot "${receivingBotId}" received message ${msg.id} in channel ${msg.channelId} from ${msg.author.tag} (bot=${msg.author.bot})`,
    );

    // Ignore all bot messages (prevents feedback loops)
    if (msg.author.bot) {
      return;
    }

    // Only handle messages if THIS bot is the one bound to this channel.
    // This prevents "several people typing" — only the correct bot responds.
    const binding = core.config.bindings.find(
      (b) => b.gateway === "discord" && b.channel === msg.channelId && b.bot === receivingBotId,
    );
    if (!binding) {
      logger.info(
        `discord-gateway: bot "${receivingBotId}" no binding for channel ${msg.channelId}`,
      );
      return; // this bot is not bound to this channel
    }
    const agentId = binding.agent;

    // Check if user is in allowedUsers
    if (!pluginConfig.allowedUsers.includes(msg.author.id)) {
      return;
    }

    // Handle slash commands
    const trimmed = msg.content.trim().toLowerCase();
    if (trimmed === "/new" || trimmed === "/reset") {
      const sessionKey = await core.sessions.getOrCreateSession(
        agentId,
        "discord",
        msg.channelId,
      );
      await (core.sessions as any).resetSession(agentId, sessionKey);
      await (msg.channel as TextChannel).send(
        `Session reset for **${agentId}**. Starting fresh.`,
      );
      return;
    }

    if (trimmed === "/status") {
      const sessionKey = await core.sessions.getOrCreateSession(
        agentId,
        "discord",
        msg.channelId,
      );
      await (msg.channel as TextChannel).send(
        `**Agent:** ${agentId}\n**Session:** \`${sessionKey}\`\n**Channel:** ${msg.channelId}`,
      );
      return;
    }

    // Normalize to IncomingMessage and route
    const incomingMessage = normalizeMessage(msg, agentId);

    // Show typing indicator while processing
    const typingInterval = setInterval(() => {
      (msg.channel as TextChannel).sendTyping().catch(() => {});
    }, 5000);
    await (msg.channel as TextChannel).sendTyping().catch(() => {});

    // Send initial "thinking" message that we'll edit with streaming content
    const sentMsg = await (msg.channel as TextChannel).send("Thinking...");
    let lastEditTime = 0;

    // Throttled streaming callback — edits the message at most every EDIT_THROTTLE_MS
    const onChunk = (accumulated: string) => {
      const now = Date.now();
      if (now - lastEditTime < EDIT_THROTTLE_MS) return;
      lastEditTime = now;

      // During streaming, show first chunk (truncated if too long)
      const preview =
        accumulated.length > DISCORD_CHAR_LIMIT - 3
          ? accumulated.slice(0, DISCORD_CHAR_LIMIT - 3) + "..."
          : accumulated;

      sentMsg.edit(preview).catch(() => {});
    };

    try {
      const response = await core.router.route(incomingMessage, onChunk);

      // Final response: replace initial message + send overflow chunks
      const chunks = splitMessage(response);
      await sentMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await (msg.channel as TextChannel).send(chunks[i]);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`discord-gateway: error handling message: ${errMsg}`);

      await sentMsg.edit(`⚠️ Error: ${errMsg}`).catch(() => {});
    } finally {
      clearInterval(typingInterval);
    }
  }
}
