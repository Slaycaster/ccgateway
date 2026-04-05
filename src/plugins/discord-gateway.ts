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
          }
        });

        client.on("messageCreate", async (msg: Message) => {
          try {
            await handleMessage(msg, botId);
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

  // ── Internal message handler ──────────────────────────────────────────

  async function handleMessage(msg: Message, receivingBotId: string): Promise<void> {
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

    // Show typing indicator
    const typingInterval = setInterval(() => {
      (msg.channel as TextChannel).sendTyping().catch(() => {});
    }, 5000);

    // Send initial typing
    await (msg.channel as TextChannel).sendTyping().catch(() => {});

    try {
      const response = await core.router.route(incomingMessage);

      // Split and send response
      const chunks = splitMessage(response);
      for (const chunk of chunks) {
        await (msg.channel as TextChannel).send(chunk);
      }
    } finally {
      clearInterval(typingInterval);
    }
  }
}
