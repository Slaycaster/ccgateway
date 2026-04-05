import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, CcgConfig } from "./config.js";

// ── AgentRegistry ──────────────────────────────────────────────────────────

export class AgentRegistry {
  private agents: Map<string, AgentConfig>;

  constructor(config: CcgConfig) {
    this.agents = new Map();
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  addAgent(agent: AgentConfig): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent with id "${agent.id}" already exists`);
    }
    this.agents.set(agent.id, agent);
  }

  removeAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  /**
   * Validate that the agent's workspace directory exists and contains a CLAUDE.md file.
   */
  validateWorkspace(id: string): { valid: boolean; errors: string[] } {
    const agent = this.agents.get(id);
    const errors: string[] = [];

    if (!agent) {
      return { valid: false, errors: [`Agent "${id}" not found in registry`] };
    }

    if (!existsSync(agent.workspace)) {
      errors.push(`Workspace directory does not exist: ${agent.workspace}`);
    } else if (!existsSync(join(agent.workspace, "CLAUDE.md"))) {
      errors.push(
        `Workspace is missing CLAUDE.md: ${join(agent.workspace, "CLAUDE.md")}`,
      );
    }

    return { valid: errors.length === 0, errors };
  }
}
