import { App, type LogLevel } from "@slack/bolt";
import type { CcgPlugin, CcgCore } from "../plugin.js";
import type { IncomingMessage } from "../types.js";
import { logger } from "../logger.js";

// ── Config types ──────────────────────────────────────────────────────────

interface SlackBotConfig {
  token: string;           // env var reference like "$SLACK_SALT_TOKEN"
  signingSecret?: string;  // env var reference like "$SLACK_SALT_SECRET" (optional — socket mode uses appToken)
  appToken: string;        // env var reference like "$SLACK_SALT_APP_TOKEN" (for socket mode)
}

interface SlackGatewayConfig {
  bots: Record<string, SlackBotConfig>;  // botId -> config
  workspace: string;
  allowedUsers: string[];
  commands: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

/** Minimum interval between Slack message updates (rate-limit safe). */
const UPDATE_THROTTLE_MS = 1500;

/** Slack section block text limit. */
const SECTION_TEXT_LIMIT = 3000;

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
 * Split a message into chunks that fit within Slack's section block text
 * limit (3000 chars). Prefers splitting at newline boundaries.
 */
export function splitMessage(text: string, maxLen = SECTION_TEXT_LIMIT): string[] {
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

/**
 * Build Slack blocks from mrkdwn text, splitting into multiple section
 * blocks if the text exceeds the 3000-char section limit.
 */
function buildBlocks(mrkdwn: string): Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }> {
  const chunks = splitMessage(mrkdwn);
  return chunks.map((chunk) => ({
    type: "section" as const,
    text: { type: "mrkdwn" as const, text: chunk },
  }));
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
  const resolvedTokens = new Map<string, { token: string; signingSecret?: string; appToken: string }>();

  // Per-channel message queue — prevents concurrent spawns for the same channel.
  const channelLocks = new Map<string, Promise<void>>();

  // Message deduplication — socket mode can replay events during reconnection.
  const seenMessages = new Set<string>();

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
    app.message(async ({ message, say, client }) => {
      // Ignore bot messages and message_changed subtypes
      if (!message || message.subtype) return;

      // message type narrowing — we only handle standard user messages
      if (!("user" in message) || !("text" in message)) return;

      // Deduplicate — socket mode can replay events during reconnection.
      // Key includes botId so different bots can still process the same message.
      const msgTs = message.ts;
      const dedupKey = `${botId}:${msgTs}`;
      if (seenMessages.has(dedupKey)) return;
      seenMessages.add(dedupKey);
      if (seenMessages.size > 5000) {
        const all = [...seenMessages];
        seenMessages.clear();
        for (const id of all.slice(-2500)) seenMessages.add(id);
      }

      const userId = message.user;
      const text = message.text ?? "";
      const channelId = message.channel;
      const messageTs = message.ts;

      // Per-channel queue — serialize so only one spawn runs at a time
      const lockKey = `${botId}:${channelId}`;
      const prev = channelLocks.get(lockKey) ?? Promise.resolve();
      const current = prev.then(
        () => handleSlackMsg(),
        () => handleSlackMsg(),
      );
      channelLocks.set(lockKey, current);
      current.finally(() => {
        if (channelLocks.get(lockKey) === current) {
          channelLocks.delete(lockKey);
        }
      });
      return current;

      async function handleSlackMsg(): Promise<void> {
        const threadTs = "thread_ts" in message ? message.thread_ts : undefined;

        logger.info(`slack: bot "${botId}" received message in channel ${channelId} from user ${userId}`);

        // Check if user is allowed (empty allowedUsers means allow everyone)
        if (pluginConfig.allowedUsers.length > 0 && !pluginConfig.allowedUsers.includes(userId)) {
          logger.debug(`slack: ignoring message from non-allowed user ${userId}`);
          return;
        }

        // Resolve agent from bindings — try exact channel first, then fall back
        // to bot-level binding (needed for Slack DMs where channel IDs are dynamic)
        const agentId =
          core.router.resolveAgent("slack", channelId) ??
          core.router.resolveAgentByBot("slack", botId);
        if (!agentId) {
          logger.debug(`slack: no agent bound to channel ${channelId} or bot ${botId}`);
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

        // Post initial "Thinking..." message that we'll update with streaming content
        const replyTs = threadTs ?? messageTs;
        let initialMsg: { ts?: string } | undefined;
        try {
          initialMsg = await client.chat.postMessage({
            channel: channelId,
            text: "Thinking...",
            thread_ts: replyTs,
          }) as { ts?: string };
        } catch {
          // Fallback: use say() if postMessage fails
          initialMsg = await say({ text: "Thinking...", thread_ts: replyTs }) as { ts?: string };
        }

        const sentTs = initialMsg?.ts;
        let lastUpdateTime = 0;

        // Throttled streaming callback — updates the message at most every UPDATE_THROTTLE_MS
        const onChunk = (accumulated: string) => {
          if (!sentTs) return;
          const now = Date.now();
          if (now - lastUpdateTime < UPDATE_THROTTLE_MS) return;
          lastUpdateTime = now;

          const mrkdwn = markdownToMrkdwn(accumulated);
          // Cap at section limit for streaming preview
          const preview =
            mrkdwn.length > SECTION_TEXT_LIMIT - 3
              ? mrkdwn.slice(0, SECTION_TEXT_LIMIT - 3) + "..."
              : mrkdwn;

          client.chat.update({
            channel: channelId,
            ts: sentTs,
            text: preview,
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: preview },
              },
            ],
          }).catch(() => {});
        };

        try {
          // Extract file attachments (Slack files require bot token to download)
          const attachments: IncomingMessage["attachments"] = [];
          if ("files" in message && Array.isArray(message.files)) {
            const bot = bots.find((b) => b.botId === botId);
            const token = bot ? resolvedTokens.get(botId)?.token : undefined;

            for (const file of message.files) {
              const url = file.url_private_download ?? file.url_private;
              if (!url) continue;

              try {
                const resp = await fetch(url, {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (!resp.ok) continue;

                attachments.push({
                  type: file.mimetype ?? "application/octet-stream",
                  data: Buffer.from(await resp.arrayBuffer()),
                  filename: file.name ?? undefined,
                });
              } catch {
                // Skip failed downloads
              }
            }
          }

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
            attachments,
          };

          // Route the message with streaming callback
          const response = await core.router.route(incoming, onChunk);

          // Final update: replace initial message + send overflow chunks
          const mrkdwn = markdownToMrkdwn(response);
          const blocks = buildBlocks(mrkdwn);

          if (sentTs) {
            // First block goes into the edited message
            await client.chat.update({
              channel: channelId,
              ts: sentTs,
              text: blocks[0]?.text.text ?? response,
              blocks: [blocks[0]],
            });

            // Remaining blocks as new messages
            for (let i = 1; i < blocks.length; i++) {
              await say({
                text: blocks[i].text.text,
                blocks: [blocks[i]],
                thread_ts: replyTs,
              });
            }
          } else {
            // No initial message to edit — send all as new
            for (const block of blocks) {
              await say({
                text: block.text.text,
                blocks: [block],
                thread_ts: replyTs,
              });
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`slack: error handling message: ${errMsg}`);

          // Update initial message with error, or send new error message
          if (sentTs) {
            await client.chat.update({
              channel: channelId,
              ts: sentTs,
              text: `:warning: Error: ${errMsg}`,
            }).catch(() => {});
          } else {
            await say({
              text: `:warning: Error: ${errMsg}`,
              thread_ts: replyTs,
            });
          }
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
        const signingSecret = botConfig.signingSecret ? resolveToken(botConfig.signingSecret) : undefined;
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
          ...(tokens.signingSecret ? { signingSecret: tokens.signingSecret } : {}),
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
