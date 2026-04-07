import { join } from "node:path";
import { getCcgHome } from "./config.js";
import { logger } from "./logger.js";
import type {
  CcgConfig,
  AgentConfig,
  IncomingMessage,
} from "./types.js";

// ── Forward-declared interfaces ────────────────────────────────────────────
// These will be implemented by later beads; defined here so plugins can
// type against them today.

export interface AgentRegistry {
  getAgent(id: string): AgentConfig | undefined;
  listAgents(): AgentConfig[];
}

export interface SessionManager {
  getOrCreateSession(
    agentId: string,
    source: string,
    sourceId: string,
  ): string;
  resetSession(agentId: string, sessionKey: string): Promise<void>;
}

export interface MessageRouter {
  route(message: IncomingMessage, onChunk?: (accumulated: string) => void): Promise<string>;
  resolveAgent(gateway: string, channelId: string): string | undefined;
  resolveAgentByBot(gateway: string, botId: string): string | undefined;
}

// ── Core API exposed to plugins ────────────────────────────────────────────

export interface CcgCore {
  config: CcgConfig;
  agents: AgentRegistry;
  sessions: SessionManager;
  router: MessageRouter;
  send(agentId: string, message: string, fromAgent?: string): Promise<void>;
}

// ── Plugin interface ───────────────────────────────────────────────────────

export type PluginType = "gateway" | "skill" | "tool";

export interface CcgPlugin {
  name: string;
  type: PluginType;
  init(core: CcgCore): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/** A module's default export must be a factory that returns a CcgPlugin. */
export type PluginFactory = (config?: unknown) => CcgPlugin;

// ── Plugin loader ──────────────────────────────────────────────────────────

export class PluginLoader {
  private plugins: CcgPlugin[] = [];

  /**
   * Loads all enabled plugins listed in `config.plugins`.
   *
   * For each entry the loader tries, in order:
   *   1. `import(name)` — works for packages in node_modules
   *   2. `import($CCG_HOME/plugins/<name>/index.js)`
   *
   * The module's default export must be a `PluginFactory` (a function
   * returning a `CcgPlugin`).
   */
  async loadPlugins(config: CcgConfig, core: CcgCore): Promise<void> {
    for (const entry of config.plugins) {
      if (!entry.enabled) {
        logger.debug(`plugin: skipping disabled plugin "${entry.name}"`);
        continue;
      }

      let mod: { default: PluginFactory };
      try {
        mod = await this.importPlugin(entry.name);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        logger.error(
          `plugin: failed to import "${entry.name}": ${message}`,
        );
        throw new Error(`Failed to load plugin "${entry.name}": ${message}`);
      }

      if (typeof mod.default !== "function") {
        throw new Error(
          `Plugin "${entry.name}" does not default-export a factory function`,
        );
      }

      const plugin = mod.default(entry.config);
      await plugin.init(core);
      this.plugins.push(plugin);
      logger.info(
        `plugin: loaded "${plugin.name}" (type=${plugin.type})`,
      );
    }
  }

  /** Start all loaded plugins (in load order). */
  async startAll(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.start) {
        await plugin.start();
        logger.info(`plugin: started "${plugin.name}"`);
      }
    }
  }

  /** Stop all loaded plugins (reverse of load order). */
  async stopAll(): Promise<void> {
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const plugin = this.plugins[i];
      if (plugin.stop) {
        await plugin.stop();
        logger.info(`plugin: stopped "${plugin.name}"`);
      }
    }
  }

  /** Register a plugin that was created externally (e.g., built-in plugins). */
  registerPlugin(plugin: CcgPlugin): void {
    this.plugins.push(plugin);
  }

  /** Returns all loaded plugins. */
  getPlugins(): CcgPlugin[] {
    return [...this.plugins];
  }

  /** Returns loaded plugins filtered by type. */
  getPluginsByType(type: PluginType): CcgPlugin[] {
    return this.plugins.filter((p) => p.type === type);
  }

  /** Returns a specific plugin by name, or undefined. */
  getPlugin(name: string): CcgPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Attempt to import a plugin module.
   * Tries the bare name first (node_modules), then falls back to
   * `$CCG_HOME/plugins/<name>/index.js`.
   */
  private async importPlugin(
    name: string,
  ): Promise<{ default: PluginFactory }> {
    try {
      return await import(name);
    } catch {
      // Fall back to the local plugins directory
      const localPath = join(getCcgHome(), "plugins", name, "index.js");
      return await import(localPath);
    }
  }
}
