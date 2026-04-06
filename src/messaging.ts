import type { AgentRegistry } from "./agents.js";
import type { MessageRouter } from "./router.js";
import type { PluginLoader } from "./plugin.js";
import type { BindingConfig } from "./config.js";
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

// ── Inbox types ──────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string;
  content: string;
  ts: number;
  read: boolean;
}

// ── Helper types ─────────────────────────────────────────────────────────

type SendToChannelFn = (
  channelId: string,
  botId: string,
  content: string,
) => Promise<void>;

// ── CrossAgentMessenger ──────────────────────────────────────────────────

export class CrossAgentMessenger {
  private router?: MessageRouter;

  constructor(
    private agents: AgentRegistry,
    private bindings: BindingConfig[],
    private plugins: PluginLoader,
    private ccgHome: string,
  ) {}

  /** Set the router for internal message routing (called after router is created) */
  setRouter(router: MessageRouter): void {
    this.router = router;
  }

  /**
   * Send a message to an agent. The request is posted to the target's
   * channel for visibility, then the target agent processes it **in the
   * background**. When done, the response is posted to both the target's
   * channel and the sender's channel.
   *
   * Returns immediately after posting the request — does NOT block waiting
   * for the target agent to finish.
   */
  async send(
    toAgentId: string,
    content: string,
    fromAgentId?: string,
  ): Promise<void> {
    // Validate target agent exists
    const targetAgent = this.agents.getAgent(toAgentId);
    if (!targetAgent) {
      throw new Error(`Agent "${toAgentId}" not found`);
    }

    // 1. Find target agent's primary binding (first binding where agent matches)
    const binding = this.bindings.find((b) => b.agent === toAgentId);

    if (binding) {
      const sendToChannel = this.getSendToChannel(binding.gateway);

      // 2. Post the request to the target's channel for human visibility
      if (sendToChannel) {
        let senderBotId = binding.bot;
        if (fromAgentId) {
          const senderBinding = this.bindings.find(
            (b) => b.agent === fromAgentId && b.gateway === binding.gateway,
          );
          if (senderBinding) {
            senderBotId = senderBinding.bot;
          }
        }

        await sendToChannel(binding.channel, senderBotId, content);
      }

      // 3. Route in the background — don't block the caller.
      //    Uses spawnStreaming (via onChunk no-op) for activity-based timeout.
      if (this.router) {
        this.routeInBackground(
          toAgentId,
          content,
          fromAgentId,
          binding,
          sendToChannel,
        );
      }

      return;
    }

    // 4. No binding or no usable gateway plugin — fall back to inbox
    await this.sendToInbox(toAgentId, content, fromAgentId);
  }

  /**
   * Route a cross-agent message in the background and post the response
   * to both the target's channel and the sender's channel when done.
   */
  private routeInBackground(
    toAgentId: string,
    content: string,
    fromAgentId: string | undefined,
    binding: BindingConfig,
    sendToChannel: SendToChannelFn | null,
  ): void {
    // Fire and forget — errors are logged, not thrown
    void (async () => {
      try {
        // Use a no-op onChunk to trigger spawnStreaming (activity-based timeout)
        const response = await this.router!.route(
          {
            from: {
              gateway: "internal",
              channel: binding.channel,
              user: fromAgentId || "system",
              userId: fromAgentId || "system",
              messageId: `xagent-${Date.now()}`,
            },
            to: { agent: toAgentId },
            content,
            attachments: [],
          },
          () => {}, // no-op onChunk — enables streaming/activity timeout
        );

        if (sendToChannel) {
          // Post the agent's response in their own channel
          await sendToChannel(binding.channel, binding.bot, response);

          // Post the response back to the sender's channel so they see the reply
          if (fromAgentId) {
            const senderBinding = this.bindings.find(
              (b) => b.agent === fromAgentId && b.gateway === binding.gateway,
            );
            if (senderBinding && senderBinding.channel !== binding.channel) {
              await sendToChannel(
                senderBinding.channel,
                binding.bot,
                `[from ${toAgentId}] ${response}`,
              );
            }
          }
        }

        logger.info(
          `messaging: cross-agent ${fromAgentId || "system"} → ${toAgentId} completed`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          `messaging: cross-agent ${fromAgentId || "system"} → ${toAgentId} failed: ${errMsg}`,
        );

        // Post error to sender's channel if possible
        if (sendToChannel && fromAgentId) {
          const senderBinding = this.bindings.find(
            (b) => b.agent === fromAgentId && b.gateway === binding.gateway,
          );
          if (senderBinding) {
            await sendToChannel(
              senderBinding.channel,
              binding.bot,
              `⚠️ Cross-agent message to ${toAgentId} failed: ${errMsg}`,
            ).catch(() => {});
          }
        }
      }
    })();
  }

  /**
   * Get the sendToChannel function for a gateway, if available.
   */
  private getSendToChannel(gateway: string): SendToChannelFn | null {
    const gatewayPlugins = this.plugins.getPluginsByType("gateway");
    const plugin = gatewayPlugins.find(
      (p) => p.name === `${gateway}-gateway`,
    ) as (Record<string, unknown> | undefined);

    if (plugin && typeof plugin.sendToChannel === "function") {
      return plugin.sendToChannel as SendToChannelFn;
    }
    return null;
  }

  /**
   * Direct file-based inbox write.
   * Appends to $CCG_HOME/agents/{toAgentId}/inbox.jsonl
   */
  async sendToInbox(
    toAgentId: string,
    content: string,
    fromAgentId?: string,
  ): Promise<void> {
    const msg: InboxMessage = {
      from: fromAgentId || "system",
      content,
      ts: Date.now(),
      read: false,
    };

    const inboxPath = this.getInboxPath(toAgentId);
    const dir = join(this.ccgHome, "agents", toAgentId);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await appendFile(inboxPath, JSON.stringify(msg) + "\n", "utf-8");
  }

  /**
   * Read unread inbox messages for an agent.
   */
  async readInbox(agentId: string): Promise<InboxMessage[]> {
    const inboxPath = this.getInboxPath(agentId);

    if (!existsSync(inboxPath)) {
      return [];
    }

    const raw = await readFile(inboxPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      return [];
    }

    const messages: InboxMessage[] = lines.map(
      (line) => JSON.parse(line) as InboxMessage,
    );

    return messages.filter((m) => !m.read);
  }

  /**
   * Mark all inbox messages as read.
   */
  async markInboxRead(agentId: string): Promise<void> {
    const inboxPath = this.getInboxPath(agentId);

    if (!existsSync(inboxPath)) {
      return;
    }

    const raw = await readFile(inboxPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      return;
    }

    const messages: InboxMessage[] = lines.map(
      (line) => JSON.parse(line) as InboxMessage,
    );

    const updated = messages.map((m) => ({ ...m, read: true }));
    const content = updated.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(inboxPath, content, "utf-8");
  }

  /**
   * Get inbox file path for an agent.
   */
  getInboxPath(agentId: string): string {
    return join(this.ccgHome, "agents", agentId, "inbox.jsonl");
  }
}
