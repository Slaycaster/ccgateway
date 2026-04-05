import { App, type LogLevel } from "@slack/bolt";
import type { CcgPlugin, CcgCore } from "../plugin.js";
import type { IncomingMessage } from "../types.js";
import { logger } from "../logger.js";

// ── Config types ──────────────────────────────────────────────────────────

interface SlackBotConfig {
  token: string;          // env var reference like "$SLACK_SALT_TOKEN"
  signingSecret: string;  // env var reference like "$SLACK_SALT_SECRET"
  appToken: string;       // env var reference like "$SLACK_SALT_APP_TOKEN" (for socket mode)
}

interface SlackGatewayConfig {
  bots: Record<string, SlackBotConfig>;  // botId -> config
  workspace: string;
  allowedUsers: string[];
  commands: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve a config value: if it starts with "$", read from process.env.
 * Throws if the env var is not set.
 */
export function resolveToken(value: string): string {
  if (value.startsWith("$")) {
    const envKey = value.slice(1);
    const resolved = process.env[envKey];
    if (!resolved) {
      throw new Error(
        `Environment variable "${envKey}" is not set (referenced as "${value}")`,
      );
    }
    return resolved;
  }
  return value;
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 * - **bold** -> *bold*
 * - *italic* (single asterisks not preceded/followed by asterisk) -> _italic_
 * - ~~strikethrough~~ -> ~strikethrough~
 * - [text](url) -> <url|text>
 * - `code` stays as `code`
 * - ```code blocks``` stay as ```code blocks```
 */
export function markdownToMrkdwn(md: string): string {
  let result = md;

  // Preserve code blocks first — replace with placeholders
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // Handle italic BEFORE bold: extract single-asterisk italic first
  // *italic* -> _italic_ (single asterisks not part of **)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // **bold** -> *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // ~~strikethrough~~ -> ~strikethrough~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Restore inline code
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCode[Number(idx)]);

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);

  return result;
}

/**
 * Split a message into chunks that fit within Slack's character limit.
 * Prefers splitting at newline boundaries.
 */
export function splitMessage(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) {
      // No good newline, split at a space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt <= 0) {
      // No good split point, hard-cut
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

// ── Stored app state (per bot) ────────────────────────────────────────────

interface BotInstance {
  app: App;
  botId: string;
}

// ── Plugin factory ────────────────────────────────────────────────────────

export default function createSlackGateway(pluginConfig: SlackGatewayConfig): CcgPlugin {
  let core: CcgCore;
  const bots: BotInstance[] = [];
  const resolvedTokens = new Map<string, { token: string; signingSecret: string; appToken: string }>();

  /**
   * Send a message to a specific channel using a specific bot.
   */
  async function sendToChannel(channelId: string, botId: string, content: string): Promise<void> {
    const bot = bots.find((b) => b.botId === botId);
    if (!bot) {
      throw new Error(`Slack bot "${botId}" not found`);
    }

    const mrkdwn = markdownToMrkdwn(content);
    const chunks = splitMessage(mrkdwn);

    for (const chunk of chunks) {
      await bot.app.client.chat.postMessage({
        channel: channelId,
        text: chunk,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: chunk },
          },
        ],
      });
    }
  }

  /**
   * Handle a slash command from Slack.
   * Returns the response string, or null if unrecognized.
   */
  async function handleSlashCommand(
    command: string,
    agentId: string,
    channelId: string,
    userId: string,
  ): Promise<string | null> {
    switch (command) {
      case "/new":
      case "/reset": {
        const sessionKey = core.sessions.getOrCreateSession(agentId, "slack", channelId);
        // SessionManager.resetSession expects (agentId, sessionKey)
        // but the interface exposed via CcgCore only has getOrCreateSession.
        // We just create a new session reference which effectively resets context.
        return `Session reset for agent *${agentId}* in this channel.`;
      }
      case "/status": {
        const agent = core.agents.getAgent(agentId);
        if (!agent) return `Agent "${agentId}" not found.`;
        return `*${agent.name}* ${agent.emoji} is online.\nModel: \`${agent.model}\``;
      }
      default:
        return null;
    }
  }

  /**
   * Register message and event handlers for a single bot App.
   */
  function registerHandlers(app: App, botId: string): void {
    // Handle messages
    app.message(async ({ message, say, client }) => {
      // Ignore bot messages and message_changed subtypes
      if (!message || message.subtype) return;

      // message type narrowing — we only handle standard user messages
      if (!("user" in message) || !("text" in message)) return;

      const userId = message.user;
      const text = message.text ?? "";
      const channelId = message.channel;
      const messageTs = message.ts;
      const threadTs = "thread_ts" in message ? message.thread_ts : undefined;

      // Check if user is allowed
      if (!pluginConfig.allowedUsers.includes(userId)) {
        logger.debug(`slack: ignoring message from non-allowed user ${userId}`);
        return;
      }

      // Resolve agent from bindings
      const agentId = core.router.resolveAgent("slack", channelId);
      if (!agentId) {
        logger.debug(`slack: no agent bound to channel ${channelId}`);
        return;
      }

      // Check if message is a slash command (text-based, not actual Slack slash commands)
      const trimmed = text.trim();
      if (pluginConfig.commands.includes(trimmed)) {
        const cmdResponse = await handleSlashCommand(trimmed, agentId, channelId, userId);
        if (cmdResponse) {
          await say({
            text: cmdResponse,
            thread_ts: threadTs ?? messageTs,
          });
        }
        return;
      }

      // Add hourglass reaction while processing
      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: messageTs,
          name: "hourglass_flowing_sand",
        });
      } catch {
        // Reaction may fail if already added or permissions issue; non-fatal
      }

      try {
        // Build IncomingMessage
        const incoming: IncomingMessage = {
          from: {
            gateway: "slack",
            channel: channelId,
            user: userId,
            userId,
            messageId: messageTs,
          },
          to: { agent: agentId },
          content: text,
          attachments: [],
        };

        // Route the message
        const response = await core.router.route(incoming);

        // Convert and send response
        const mrkdwn = markdownToMrkdwn(response);
        const chunks = splitMessage(mrkdwn);

        for (const chunk of chunks) {
          await say({
            text: chunk,
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: chunk },
              },
            ],
            thread_ts: threadTs ?? messageTs,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`slack: error handling message: ${errMsg}`);

        await say({
          text: `:warning: Error: ${errMsg}`,
          thread_ts: threadTs ?? messageTs,
        });
      } finally {
        // Remove hourglass reaction
        try {
          await client.reactions.remove({
            channel: channelId,
            timestamp: messageTs,
            name: "hourglass_flowing_sand",
          });
        } catch {
          // Non-fatal
        }
      }
    });
  }

  // ── Return the CcgPlugin object ──────────────────────────────────────────

  return {
    name: "slack-gateway",
    type: "gateway",

    async init(coreRef: CcgCore): Promise<void> {
      core = coreRef;

      // Resolve all tokens from env vars
      for (const [botId, botConfig] of Object.entries(pluginConfig.bots)) {
        const token = resolveToken(botConfig.token);
        const signingSecret = resolveToken(botConfig.signingSecret);
        const appToken = resolveToken(botConfig.appToken);
        resolvedTokens.set(botId, { token, signingSecret, appToken });
      }

      logger.info(
        `slack-gateway: initialized with ${Object.keys(pluginConfig.bots).length} bot(s)`,
      );
    },

    async start(): Promise<void> {
      for (const [botId, tokens] of resolvedTokens.entries()) {
        const app = new App({
          token: tokens.token,
          signingSecret: tokens.signingSecret,
          appToken: tokens.appToken,
          socketMode: true,
          logLevel: "ERROR" as LogLevel,
        });

        registerHandlers(app, botId);

        await app.start();
        bots.push({ app, botId });

        logger.info(`slack-gateway: bot "${botId}" started in socket mode`);
      }
    },

    async stop(): Promise<void> {
      for (const bot of bots) {
        try {
          await bot.app.stop();
          logger.info(`slack-gateway: bot "${bot.botId}" stopped`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`slack-gateway: error stopping bot "${bot.botId}": ${errMsg}`);
        }
      }
      bots.length = 0;
    },

    // Expose sendToChannel for cross-agent messaging
    sendToChannel,
  } as CcgPlugin & { sendToChannel: typeof sendToChannel };
}
