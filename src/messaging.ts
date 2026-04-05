import type { AgentRegistry } from "./agents.js";
import type { MessageRouter } from "./router.js";
import type { PluginLoader } from "./plugin.js";
import type { BindingConfig } from "./config.js";
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Inbox types ──────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string;
  content: string;
  ts: number;
  read: boolean;
}

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
   * Send a message to an agent. Uses channel-native messaging if the agent
   * has a gateway binding, otherwise falls back to file-based inbox.
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
      // 2a. Post to Discord/Slack for human visibility (optional)
      const gatewayPlugins = this.plugins.getPluginsByType("gateway");
      const plugin = gatewayPlugins.find(
        (p) => p.name === `${binding.gateway}-gateway`,
      ) as (Record<string, unknown> | undefined);

      if (plugin && typeof plugin.sendToChannel === "function") {
        let senderBotId = binding.bot;
        if (fromAgentId) {
          const senderBinding = this.bindings.find(
            (b) => b.agent === fromAgentId && b.gateway === binding.gateway,
          );
          if (senderBinding) {
            senderBotId = senderBinding.bot;
          }
        }

        // Post to channel so humans can see the cross-agent message
        await (plugin.sendToChannel as (
          channelId: string,
          botId: string,
          content: string,
        ) => Promise<void>)(binding.channel, senderBotId, content);
      }

      // 2b. Route internally so the target agent actually processes it.
      //     Bot messages are ignored by the gateway, so we route directly.
      if (this.router) {
        const response = await this.router.route({
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
        });

        // Post the agent's response back to their channel for visibility
        if (plugin && typeof plugin.sendToChannel === "function") {
          await (plugin.sendToChannel as (
            channelId: string,
            botId: string,
            content: string,
          ) => Promise<void>)(binding.channel, binding.bot, response);
        }
      }
      return;
    }

    // 3. No binding or no usable gateway plugin — fall back to inbox
    await this.sendToInbox(toAgentId, content, fromAgentId);
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
