import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface MessagingPolicy {
  /** Agent IDs this agent is allowed to message. If omitted, no restrictions. */
  allowedTargets?: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  emoji: string;
  workspace: string;
  model: string;
  skills: string[];
  allowedTools: string[];
  maxConcurrentSessions: number;
  timeoutMs?: number;
  messagingPolicy?: MessagingPolicy;
}

export interface BindingConfig {
  agent: string;
  gateway: string;
  channel: string;
  bot: string;
}

export interface PluginEntry {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CcgConfig {
  agents: AgentConfig[];
  bindings: BindingConfig[];
  plugins: PluginEntry[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CcgConfig = {
  agents: [],
  bindings: [],
  plugins: [],
};

/**
 * Returns the CCG_HOME directory.
 * Uses `CCG_HOME` env var if set, otherwise defaults to `~/.ccgateway`.
 */
export function getCcgHome(): string {
  return process.env.CCG_HOME || join(homedir(), ".ccgateway");
}

/**
 * Returns the path to the config file inside CCG_HOME.
 */
function configPath(): string {
  return join(getCcgHome(), "config.json");
}

// ── Core functions ──────────────────────────────────────────────────────────

/**
 * Loads the CcgConfig from `$CCG_HOME/config.json`.
 * If the file does not exist, returns the default (empty) config.
 */
export async function loadConfig(): Promise<CcgConfig> {
  const path = configPath();

  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as Partial<CcgConfig>;

  return {
    agents: parsed.agents ?? [],
    bindings: parsed.bindings ?? [],
    plugins: parsed.plugins ?? [],
  };
}

/**
 * Saves the CcgConfig to `$CCG_HOME/config.json`.
 * Creates the CCG_HOME directory if it doesn't exist.
 */
export async function saveConfig(config: CcgConfig): Promise<void> {
  const home = getCcgHome();
  if (!existsSync(home)) {
    await mkdir(home, { recursive: true });
  }

  const path = configPath();
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Ensures the standard CCG_HOME subdirectories exist:
 *   agents, skills, plugins, logs
 */
export async function ensureDirectories(): Promise<void> {
  const home = getCcgHome();
  const dirs = ["agents", "skills", "plugins", "logs"];

  for (const dir of dirs) {
    const dirPath = join(home, dir);
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }
  }
}
