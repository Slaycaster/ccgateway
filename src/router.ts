import type { AgentRegistry } from "./agents.js";
import type { SessionManager } from "./sessions.js";
import type { ContextBuilder } from "./context.js";
import type { CCSpawner } from "./spawner.js";
import type { IncomingMessage, BindingConfig } from "./types.js";

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

    // 4. Build context
    const systemPrompt = await this.context.build(agentId, sessionKey);

    // 5. Spawn claude --print
    const result = await this.spawner.spawn({
      workspace: agent.workspace,
      message: message.content,
      systemPrompt,
      model: agent.model,
      allowedTools: agent.allowedTools,
    });

    // 6. Handle failure: append error to session and throw
    if (result.exitCode !== 0) {
      const errorContent = result.response || `Spawner failed with exit code ${result.exitCode}`;
      await this.sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content: `[error] ${errorContent}`,
        ts: Date.now(),
        tokens: result.tokensEstimate,
      });
      throw new Error(
        `Spawner exited with code ${result.exitCode}: ${errorContent}`,
      );
    }

    // 7. Append assistant response to session
    await this.sessions.appendMessage(agentId, sessionKey, {
      role: "assistant",
      content: result.response,
      ts: Date.now(),
      tokens: result.tokensEstimate,
    });

    // 8. Return response text
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
}
