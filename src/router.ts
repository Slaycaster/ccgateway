import type { AgentRegistry } from "./agents.js";
import type { SessionManager } from "./sessions.js";
import type { ContextBuilder } from "./context.js";
import type { CCSpawner } from "./spawner.js";
import type { IncomingMessage, Attachment, BindingConfig } from "./types.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── MessageRouter ─────────────────────────────────────────────────────────

export class MessageRouter {
  constructor(
    private agents: AgentRegistry,
    private sessions: SessionManager,
    private context: ContextBuilder,
    private spawner: CCSpawner,
    private bindings: BindingConfig[],
  ) {}

  /**
   * Resolve which agent handles a message based on bindings.
   * Given (gateway, channelId), find the matching binding and return binding.agent.
   */
  resolveAgent(gateway: string, channelId: string): string | undefined {
    const binding = this.bindings.find(
      (b) => b.gateway === gateway && b.channel === channelId,
    );
    return binding?.agent;
  }

  /**
   * Resolve agent by gateway + bot ID (fallback for gateways like Slack
   * where DM channel IDs are dynamic and won't match a static binding).
   */
  resolveAgentByBot(gateway: string, botId: string): string | undefined {
    const binding = this.bindings.find(
      (b) => b.gateway === gateway && b.bot === botId,
    );
    return binding?.agent;
  }

  /**
   * Full message dispatch pipeline.
   *
   * 1. Look up agent config from registry
   * 2. Derive session key: {agentId}:{gateway}:{channel}
   * 3. Get or create session
   * 4. Append user message to session
   * 5. Build context
   * 6. Spawn claude --print
   * 7. Append assistant response to session (or error on failure)
   * 8. Return response text
   */
  async route(message: IncomingMessage): Promise<string> {
    const agentId = message.to.agent;

    // 1. Get agent config
    const agent = this.agents.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found in registry`);
    }

    // 2. Derive session key
    const sessionKey = this.sessions.getOrCreateSession(
      agentId,
      message.from.gateway,
      message.from.channel,
    );

    // 3. Append user message to session
    await this.sessions.appendMessage(agentId, sessionKey, {
      role: "user",
      content: message.content,
      ts: Date.now(),
      source: message.from.gateway,
      sourceUser: message.from.user,
      sourceMessageId: message.from.messageId,
    });

    // 4. Download attachments (if any) so Claude can read them
    let attachmentDir: string | undefined;
    let messageContent = message.content;
    if (message.attachments.length > 0) {
      const result = await this.downloadAttachments(
        message.attachments,
        agent.workspace,
      );
      attachmentDir = result.dir;
      if (result.paths.length > 0) {
        const fileList = result.paths
          .map((p) => `  - ${p}`)
          .join("\n");
        messageContent += `\n\n[Attached files — use the Read tool to view them]\n${fileList}`;
      }
    }

    // 5. Build context
    const systemPrompt = await this.context.build(agentId, sessionKey);

    // 6. Spawn claude --print
    const result = await this.spawner.spawn({
      workspace: agent.workspace,
      message: messageContent,
      systemPrompt,
      model: agent.model,
      allowedTools: agent.allowedTools,
      ...(agent.timeoutMs ? { timeoutMs: agent.timeoutMs } : {}),
    });

    // 7. Clean up attachment temp dir
    if (attachmentDir) {
      rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
    }

    // 8. Handle failure: append error to session and throw
    if (result.exitCode !== 0) {
      const isTimeout = result.exitCode === 124;
      const stderrHint = result.stderr ? `\n\nDetails: ${result.stderr.slice(0, 500)}` : "";
      const errorContent = isTimeout
        ? "The task timed out — it took longer than the allowed time. Try breaking it into smaller steps, or increase the agent's `timeoutMs` setting."
        : (result.response || `Spawner failed with exit code ${result.exitCode}`) + stderrHint;
      await this.sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content: `[error] ${errorContent}`,
        ts: Date.now(),
        tokens: result.tokensEstimate,
      });
      throw new Error(errorContent);
    }

    // 9. Append assistant response to session
    await this.sessions.appendMessage(agentId, sessionKey, {
      role: "assistant",
      content: result.response,
      ts: Date.now(),
      tokens: result.tokensEstimate,
    });

    // 10. Return response text
    return result.response;
  }

  /**
   * Add a binding at runtime.
   */
  addBinding(binding: BindingConfig): void {
    this.bindings.push(binding);
  }

  /**
   * Get all bindings for a given agent.
   */
  getBindingsForAgent(agentId: string): BindingConfig[] {
    return this.bindings.filter((b) => b.agent === agentId);
  }

  /**
   * Get the primary (first) binding for an agent.
   */
  getPrimaryBinding(agentId: string): BindingConfig | undefined {
    return this.bindings.find((b) => b.agent === agentId);
  }

  /**
   * Download attachments to a temp directory and return their local paths.
   */
  private async downloadAttachments(
    attachments: Attachment[],
    workspace: string,
  ): Promise<{ dir: string; paths: string[] }> {
    const dir = join(tmpdir(), `ccg-attach-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const paths: string[] = [];

    for (const att of attachments) {
      if (!att.url) continue;

      try {
        const resp = await fetch(att.url);
        if (!resp.ok) continue;

        const buffer = Buffer.from(await resp.arrayBuffer());
        const filename = att.filename || `attachment-${paths.length}`;
        const filePath = join(dir, filename);
        await writeFile(filePath, buffer);
        paths.push(filePath);
      } catch {
        // Skip failed downloads
      }
    }

    return { dir, paths };
  }
}
