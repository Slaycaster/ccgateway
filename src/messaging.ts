import type { AgentRegistry } from "./agents.js";
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
  constructor(
    private agents: AgentRegistry,
    private bindings: BindingConfig[],
    private plugins: PluginLoader,
    private ccgHome: string,
  ) {}

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
      // 2a. Find the gateway plugin that handles this binding's gateway type
      const gatewayPlugins = this.plugins.getPluginsByType("gateway");
      const plugin = gatewayPlugins.find(
        (p) => p.name === `${binding.gateway}-gateway`,
      ) as (Record<string, unknown> | undefined);

      if (
        plugin &&
        typeof plugin.sendToChannel === "function"
      ) {
        // 2b. Determine which bot to send as.
        //     If fromAgentId is provided, look for a binding for that agent
        //     on the same gateway to find their bot identity.
        //     Fall back to the target binding's bot.
        let senderBotId = binding.bot;
        if (fromAgentId) {
          const senderBinding = this.bindings.find(
            (b) => b.agent === fromAgentId && b.gateway === binding.gateway,
          );
          if (senderBinding) {
            senderBotId = senderBinding.bot;
          }
        }

        // 2c. Send via gateway plugin
        await (plugin.sendToChannel as (
          channelId: string,
          botId: string,
          content: string,
        ) => Promise<void>)(binding.channel, senderBotId, content);
        return;
      }
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
