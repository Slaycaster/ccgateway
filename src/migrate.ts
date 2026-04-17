import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { saveConfig, ensureDirectories, getCcgHome } from './config.js';
import type { CcgConfig, AgentConfig, BindingConfig, PluginEntry } from './config.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface MigrateOptions {
  configPaths?: string[];  // explicit openclaw.json paths (disables auto-discovery)
  dryRun?: boolean;
}

// ── OpenClaw JSON shape ─────────────────────────────────────────────────────

interface OpenClawAgent {
  id: string;
  name?: string;
  default?: boolean;
  workspace?: string;
  agentDir?: string;
  model?: {
    primary?: string;
  };
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
  };
  subagents?: {
    allowAgents?: string[];
    maxConcurrent?: number;
  };
}

interface OpenClawBinding {
  agentId: string;
  match: {
    channel: string;
    accountId: string;
    peer?: {
      kind: string;
      id: string;
    };
  };
}

interface SlackAccountConfig {
  botToken?: string;
  appToken?: string;
}

interface OpenClawConfig {
  agents?: {
    defaults?: {
      model?: { primary?: string };
      workspace?: string;
      maxConcurrent?: number;
    };
    list?: OpenClawAgent[];
  };
  bindings?: OpenClawBinding[];
  channels?: {
    discord?: {
      accounts?: Record<string, { token?: string; [key: string]: unknown }>;
    };
    slack?: {
      botToken?: string;
      appToken?: string;
      accounts?: Record<string, SlackAccountConfig>;
    };
  };
}

// ── Instance representation ─────────────────────────────────────────────────

interface OpenClawInstance {
  name: string;
  configPath: string;
  config: OpenClawConfig;
}

// ── Migration ───────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_TOOLS = ['Edit', 'Read', 'Write', 'Bash', 'Grep', 'Glob'];

/**
 * Strip provider prefix from a model name.
 * e.g. "anthropic/claude-opus-4-6" -> "claude-opus-4-6"
 */
export function stripModelPrefix(model: string): string {
  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) return model;
  return model.slice(slashIndex + 1);
}

/**
 * Generate a Discord bot token env var name.
 * e.g. "ginger" -> "DISCORD_GINGER_TOKEN"
 */
export function botTokenEnvVar(accountName: string): string {
  return `DISCORD_${accountName.toUpperCase()}_TOKEN`;
}

/**
 * Generate Slack bot token env var names.
 * e.g. "default" -> { token: "SLACK_DEFAULT_TOKEN", appToken: "SLACK_DEFAULT_APP_TOKEN" }
 */
export function slackTokenEnvVars(botName: string): { token: string; appToken: string } {
  const upper = botName.toUpperCase();
  return {
    token: `SLACK_${upper}_TOKEN`,
    appToken: `SLACK_${upper}_APP_TOKEN`,
  };
}

/**
 * Derive an instance name from an openclaw directory path.
 * ~/.openclaw/openclaw.json        → "openclaw"
 * ~/.openclaw-sentri/openclaw.json → "sentri"
 */
export function deriveInstanceName(configPath: string): string {
  const dir = basename(dirname(configPath));
  // Strip leading dot
  let name = dir.startsWith('.') ? dir.slice(1) : dir;
  // Strip "openclaw" prefix and leading dash/underscore
  if (name === 'openclaw') return 'openclaw';
  if (name.startsWith('openclaw-')) return name.slice('openclaw-'.length);
  if (name.startsWith('openclaw_')) return name.slice('openclaw_'.length);
  return name;
}

/**
 * Auto-discover OpenClaw instances by globbing ~/.openclaw* /openclaw.json
 */
export async function discoverInstances(): Promise<string[]> {
  const home = homedir();
  const paths: string[] = [];

  // node:fs/promises glob is available in Node 22+
  // Fallback to manual scanning if not available
  try {
    for await (const entry of glob(join(home, '.openclaw*', 'openclaw.json'))) {
      paths.push(entry);
    }
  } catch {
    // Fallback: check the default path
    const defaultPath = join(home, '.openclaw', 'openclaw.json');
    if (existsSync(defaultPath)) {
      paths.push(defaultPath);
    }
  }

  return paths.sort();
}

/**
 * Resolve agent ID collisions across multiple instances.
 * Returns a map from "instanceName:originalId" → "resolvedId".
 * Only renames when there's an actual collision.
 */
export function resolveCollisions(
  instanceAgents: Array<{ instanceName: string; agents: AgentConfig[] }>,
): { renames: Map<string, string>; summary: string[] } {
  // Count how many instances define each agent ID
  const idCount = new Map<string, number>();
  for (const { agents } of instanceAgents) {
    for (const agent of agents) {
      idCount.set(agent.id, (idCount.get(agent.id) || 0) + 1);
    }
  }

  const renames = new Map<string, string>();
  const summary: string[] = [];

  for (const { instanceName, agents } of instanceAgents) {
    for (const agent of agents) {
      const key = `${instanceName}:${agent.id}`;
      if (idCount.get(agent.id)! > 1) {
        const newId = `${instanceName}-${agent.id}`;
        renames.set(key, newId);
        summary.push(`  ${agent.id} (${instanceName}) → ${newId}`);
        agent.id = newId;
      } else {
        renames.set(key, agent.id);
      }
    }
  }

  return { renames, summary };
}

/**
 * Migrate from OpenClaw configuration to ccgateway config.
 * Supports multi-instance discovery and merging.
 */
export async function migrateFromOpenClaw(options: MigrateOptions = {}): Promise<void> {
  // 1. Discover or use explicit config paths
  let configPaths: string[];

  if (options.configPaths && options.configPaths.length > 0) {
    configPaths = options.configPaths;
  } else {
    configPaths = await discoverInstances();
  }

  if (configPaths.length === 0) {
    throw new Error(
      `No OpenClaw config found. Looked for ~/.openclaw*/openclaw.json\n` +
      `Specify the path with: ccg migrate openclaw --config <path>`,
    );
  }

  // 2. Load all instances
  const instances: OpenClawInstance[] = [];
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) {
      throw new Error(
        `OpenClaw config not found at: ${configPath}\n` +
        `Specify the path with: ccg migrate openclaw --config <path>`,
      );
    }
    const raw = await readFile(configPath, 'utf-8');
    const config: OpenClawConfig = JSON.parse(raw);
    const name = deriveInstanceName(configPath);
    instances.push({ name, configPath, config });
  }

  // 3. Extract agents from each instance (with synthesis for missing agents.list)
  const instanceAgents: Array<{ instanceName: string; agents: AgentConfig[] }> = [];
  for (const instance of instances) {
    const agents = extractAgents(instance.config, instance.name);
    instanceAgents.push({ instanceName: instance.name, agents });
  }

  // 4. Resolve agent ID collisions across all instances
  const { renames, summary: renameSummary } = resolveCollisions(instanceAgents);

  // 5. Flatten all agents
  const allAgents: AgentConfig[] = instanceAgents.flatMap(ia => ia.agents);

  // 6. Extract bindings and tokens from each instance (using resolved IDs)
  const allBindings: BindingConfig[] = [];
  const allEnvLines: string[] = [];
  const allInstructions: string[] = [];
  const allSlackBots: Record<string, { token: string; appToken: string }> = {};
  const allDiscordBots: Record<string, { token: string }> = {};
  const bindingSeen = new Set<string>();
  let guildId: string | undefined;
  const allAllowedUsers: Set<string> = new Set();

  for (const instance of instances) {
    const renameForInstance = (originalId: string): string => {
      return renames.get(`${instance.name}:${originalId}`) || originalId;
    };

    // Bindings
    const bindings = extractBindings(instance.config, allAgents, renameForInstance);
    for (const b of bindings) {
      const key = `${b.gateway}:${b.channel}:${b.bot}`;
      if (!bindingSeen.has(key)) {
        bindingSeen.add(key);
        allBindings.push(b);
      }
    }

    // Slack bindings from account structure
    const slackBindings = extractSlackBindings(instance.config, instance.name, renameForInstance, allBindings);
    for (const b of slackBindings) {
      const key = `${b.gateway}:${b.channel}:${b.bot}`;
      if (!bindingSeen.has(key)) {
        bindingSeen.add(key);
        allBindings.push(b);
      }
    }

    // Discord tokens
    const discord = extractDiscordBotTokens(instance.config);
    for (const [name, bot] of Object.entries(discord.pluginBots)) {
      allDiscordBots[name] = bot;
    }
    allEnvLines.push(...discord.envLines);
    allInstructions.push(...discord.instructions);

    // Slack tokens
    const slack = extractSlackBotTokens(instance.config, instance.name);
    for (const [name, bot] of Object.entries(slack.pluginBots)) {
      allSlackBots[name] = bot;
    }
    allEnvLines.push(...slack.envLines);
    allInstructions.push(...slack.instructions);

    // Guild ID (first found)
    if (!guildId) {
      guildId = extractGuildId(instance.config);
    }

    // Allowed users
    for (const u of extractAllowedUsers(instance.config)) {
      allAllowedUsers.add(u);
    }

  }

  // 7. Build plugin entries
  const plugins: PluginEntry[] = [];

  if (Object.keys(allDiscordBots).length > 0) {
    plugins.push({
      name: 'discord-gateway',
      enabled: true,
      config: {
        bots: allDiscordBots,
        guild: guildId || '',
        allowedUsers: [...allAllowedUsers],
        commands: ['/new', '/reset', '/status', '/stop'],
      },
    });
  }

  if (Object.keys(allSlackBots).length > 0) {
    plugins.push({
      name: 'slack-gateway',
      enabled: true,
      config: {
        bots: allSlackBots,
        workspace: '',
        allowedUsers: [...allAllowedUsers],
        commands: ['/new', '/reset', '/status', '/stop'],
      },
    });
  }

  // 8. Build ccgateway config
  const ccgConfig: CcgConfig = {
    agents: allAgents,
    bindings: allBindings,
    plugins,
  };

  // 9. Print summary
  console.log('--- OpenClaw Migration Summary ---');
  console.log(`  Instances:  ${instances.length} (${instances.map(i => i.name).join(', ')})`);
  console.log(`  Agents:     ${allAgents.length}`);
  console.log(`  Bindings:   ${allBindings.length}`);
  console.log(`  Plugins:    ${plugins.length}`);
  console.log();

  if (renameSummary.length > 0) {
    console.log('Agent ID renames (collision resolution):');
    for (const line of renameSummary) {
      console.log(line);
    }
    console.log();
  }

  if (allAgents.length > 0) {
    console.log('Agents:');
    for (const a of allAgents) {
      console.log(`  ${a.emoji || '-'} ${a.id} (${a.name}) — model: ${a.model}, workspace: ${a.workspace}`);
    }
    console.log();
  }

  if (allBindings.length > 0) {
    console.log('Bindings:');
    for (const b of allBindings) {
      console.log(`  ${b.agent} <- ${b.gateway}:${b.channel} (bot: ${b.bot})`);
    }
    console.log();
  }

  if (plugins.length > 0) {
    console.log('Plugins:');
    for (const p of plugins) {
      console.log(`  ${p.name} (${p.enabled ? 'enabled' : 'disabled'})`);
    }
    console.log();
  }

  if (allEnvLines.length > 0) {
    console.log(`Bot tokens found: ${allEnvLines.length}`);
    for (const line of allInstructions) {
      console.log(line);
    }
    console.log();
  }

  // 10. Dry run check
  if (options.dryRun) {
    console.log('[dry-run] No files were written.');
    return;
  }

  // 11. Save config, .env, and ensure directories
  await ensureDirectories();
  await saveConfig(ccgConfig);

  const home = getCcgHome();

  // Write .env with actual bot tokens
  if (allEnvLines.length > 0) {
    const envPath = join(home, '.env');
    await writeFile(envPath, allEnvLines.join('\n') + '\n', 'utf-8');
    console.log(`Bot tokens written to: ${envPath}`);
  }

  console.log(`Config written to: ${join(home, 'config.json')}`);

  // Install Claude Code /talk skill
  try {
    await installCcgSkill();
    console.log('Claude Code /talk skill installed.');
  } catch {
    console.log('Note: Could not install Claude Code /talk skill (run `ccg install-skill` manually).');
  }

  console.log();
  console.log('To start ccgateway, load the .env first:');
  console.log(`  source ${join(home, '.env')} && ccg start`);
  console.log();
  console.log('Migration complete.');
}

// ── Extraction helpers ──────────────────────────────────────────────────────

function extractAgents(config: OpenClawConfig, instanceName: string): AgentConfig[] {
  const defaults = config.agents?.defaults;
  const defaultModel = defaults?.model?.primary || 'claude-sonnet-4-6';
  const defaultWorkspace = defaults?.workspace || homedir();
  const defaultMaxConcurrent = defaults?.maxConcurrent || 4;

  const list = config.agents?.list;

  // Synthesize a single agent if no agents.list
  if (!list || list.length === 0) {
    return [{
      id: instanceName,
      name: instanceName,
      emoji: '',
      workspace: defaultWorkspace,
      model: stripModelPrefix(defaultModel),
      skills: [],
      allowedTools: [...DEFAULT_ALLOWED_TOOLS],
      maxConcurrentSessions: defaultMaxConcurrent,
    }];
  }

  return list.map((agent): AgentConfig => {
    const rawModel = agent.model?.primary || defaultModel;
    const model = stripModelPrefix(rawModel);
    const workspace = agent.workspace || defaultWorkspace;
    const name = agent.identity?.name || agent.name || agent.id;
    const emoji = agent.identity?.emoji || '';

    return {
      id: agent.id,
      name,
      emoji,
      workspace,
      model,
      skills: [],
      allowedTools: [...DEFAULT_ALLOWED_TOOLS],
      maxConcurrentSessions: defaultMaxConcurrent,
    };
  });
}

function extractBindings(
  config: OpenClawConfig,
  agents: AgentConfig[],
  renameId: (id: string) => string,
): BindingConfig[] {
  const bindings: BindingConfig[] = [];
  const seen = new Set<string>();

  // 1. Extract from explicit bindings array
  const ocBindings = config.bindings;
  if (ocBindings) {
    for (const binding of ocBindings) {
      const channelId = binding.match.peer?.id ?? '*';
      const key = `${binding.match.channel}:${channelId}:${binding.match.accountId}`;
      if (!seen.has(key)) {
        seen.add(key);
        bindings.push({
          agent: renameId(binding.agentId),
          gateway: binding.match.channel,
          channel: channelId,
          bot: binding.match.accountId,
        });
      }
    }
  }

  // 2. Extract from channels.discord.accounts.{bot}.guilds.{guild}.channels
  const accounts = config.channels?.discord?.accounts;
  if (accounts) {
    // Build a map of bot → agent (first matching agent for each bot)
    const botToAgent = new Map<string, string>();
    for (const agent of agents) {
      const existing = bindings.find((b) => b.bot === agent.id);
      if (existing) {
        botToAgent.set(agent.id, existing.agent);
      }
    }
    if (ocBindings) {
      for (const b of ocBindings) {
        botToAgent.set(b.match.accountId, renameId(b.agentId));
      }
    }

    for (const [botName, acct] of Object.entries(accounts)) {
      const guilds = (acct as Record<string, unknown>).guilds as Record<string, Record<string, unknown>> | undefined;
      if (!guilds) continue;

      const agentId = botToAgent.get(botName);
      if (!agentId) continue;

      for (const guild of Object.values(guilds)) {
        const channels = guild.channels as Record<string, { enabled?: boolean }> | undefined;
        if (!channels) continue;

        for (const [chId, chConf] of Object.entries(channels)) {
          if (!chConf.enabled) continue;
          const key = `discord:${chId}:${botName}`;
          if (!seen.has(key)) {
            seen.add(key);
            bindings.push({
              agent: agentId,
              gateway: 'discord',
              channel: chId,
              bot: botName,
            });
          }
        }
      }
    }
  }

  return bindings;
}

/**
 * Extract Slack bindings from channels.slack.accounts structure.
 * Each account that maps to an agent gets a gateway:'slack' binding with channel:'*'.
 */
function extractSlackBindings(
  config: OpenClawConfig,
  instanceName: string,
  renameId: (id: string) => string,
  existingBindings: BindingConfig[],
): BindingConfig[] {
  const bindings: BindingConfig[] = [];
  const slack = config.channels?.slack;
  if (!slack) return bindings;

  // Build bot→agent map from explicit bindings
  const botToAgent = new Map<string, string>();
  const ocBindings = config.bindings;
  if (ocBindings) {
    for (const b of ocBindings) {
      if (b.match.channel === 'slack') {
        botToAgent.set(b.match.accountId, renameId(b.agentId));
      }
    }
  }

  if (slack.accounts) {
    // Pattern 1: Multi-bot accounts
    for (const accountName of Object.keys(slack.accounts)) {
      const agentId = botToAgent.get(accountName);
      if (agentId) {
        bindings.push({
          agent: agentId,
          gateway: 'slack',
          channel: '*',
          bot: accountName,
        });
      }
    }
  } else if (slack.botToken) {
    // Pattern 2: Top-level single bot — named after instance
    const agentId = botToAgent.get(instanceName) || renameId(instanceName);
    bindings.push({
      agent: agentId,
      gateway: 'slack',
      channel: '*',
      bot: instanceName,
    });
  }

  return bindings;
}

interface ExtractedTokens {
  envLines: string[];
  pluginBots: Record<string, { token: string }>;
  instructions: string[];
}

interface ExtractedSlackTokens {
  envLines: string[];
  pluginBots: Record<string, { token: string; appToken: string }>;
  instructions: string[];
}

function extractDiscordBotTokens(config: OpenClawConfig): ExtractedTokens {
  const accounts = config.channels?.discord?.accounts;
  if (!accounts) return { envLines: [], pluginBots: {}, instructions: [] };

  const envLines: string[] = [];
  const pluginBots: Record<string, { token: string }> = {};
  const instructions: string[] = [];

  for (const [name, account] of Object.entries(accounts)) {
    const envVar = botTokenEnvVar(name);
    if (account.token) {
      envLines.push(`export ${envVar}=${account.token}`);
      pluginBots[name] = { token: `$${envVar}` };
      instructions.push(`  ${envVar} → ${name} bot`);
    }
  }

  return { envLines, pluginBots, instructions };
}

/**
 * Extract Slack bot tokens from an instance's config.
 * Handles both Pattern 1 (multi-bot accounts) and Pattern 2 (top-level single bot).
 */
function extractSlackBotTokens(config: OpenClawConfig, instanceName: string): ExtractedSlackTokens {
  const slack = config.channels?.slack;
  if (!slack) return { envLines: [], pluginBots: {}, instructions: [] };

  const envLines: string[] = [];
  const pluginBots: Record<string, { token: string; appToken: string }> = {};
  const instructions: string[] = [];

  if (slack.accounts) {
    // Pattern 1: Multi-bot accounts
    for (const [name, account] of Object.entries(slack.accounts)) {
      const vars = slackTokenEnvVars(name);
      if (account.botToken) {
        envLines.push(`export ${vars.token}=${account.botToken}`);
        envLines.push(`export ${vars.appToken}=${account.appToken || ''}`);
        pluginBots[name] = {
          token: `$${vars.token}`,
          appToken: `$${vars.appToken}`,
        };
        instructions.push(`  ${vars.token} → ${name} bot`);
        instructions.push(`  ${vars.appToken} → ${name} app`);
      }
    }
  } else if (slack.botToken) {
    // Pattern 2: Top-level single bot — named after instance
    const vars = slackTokenEnvVars(instanceName);
    envLines.push(`export ${vars.token}=${slack.botToken}`);
    envLines.push(`export ${vars.appToken}=${slack.appToken || ''}`);
    pluginBots[instanceName] = {
      token: `$${vars.token}`,
      appToken: `$${vars.appToken}`,
    };
    instructions.push(`  ${vars.token} → ${instanceName} bot`);
    instructions.push(`  ${vars.appToken} → ${instanceName} app`);
  }

  return { envLines, pluginBots, instructions };
}

function extractGuildId(config: OpenClawConfig): string | undefined {
  const accounts = config.channels?.discord?.accounts;
  if (!accounts) return undefined;
  for (const account of Object.values(accounts)) {
    const guilds = (account as Record<string, unknown>).guilds as Record<string, unknown> | undefined;
    if (guilds) {
      const firstGuildId = Object.keys(guilds)[0];
      if (firstGuildId) return firstGuildId;
    }
  }
  return undefined;
}

function extractAllowedUsers(config: OpenClawConfig): string[] {
  const users = new Set<string>();

  // Discord users
  const discordAccounts = config.channels?.discord?.accounts;
  if (discordAccounts) {
    for (const account of Object.values(discordAccounts)) {
      const guilds = (account as Record<string, unknown>).guilds as Record<string, Record<string, unknown>> | undefined;
      if (guilds) {
        for (const guild of Object.values(guilds)) {
          const guildUsers = guild.users as string[] | undefined;
          if (guildUsers) {
            for (const u of guildUsers) users.add(u);
          }
        }
      }
    }
  }

  return [...users];
}

// ── Init ────────────────────────────────────────────────────────────────────

/**
 * Interactive setup for new users (no OpenClaw).
 * Creates the ~/.ccgateway/ structure with a minimal starter config.
 */
export async function initNew(): Promise<void> {
  const { createInterface } = await import('node:readline');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer: string) => resolve(answer.trim()));
    });

  console.log('--- ccgateway init ---');
  console.log('Setting up a new ccgateway configuration.\n');

  const agentName = (await ask('First agent name [assistant]: ')) || 'assistant';
  const agentId = agentName.toLowerCase().replace(/\s+/g, '-');
  const workspace = (await ask(`Workspace directory [${process.cwd()}]: `)) || process.cwd();
  const model = (await ask('Model [claude-sonnet-4-6]: ')) || 'claude-sonnet-4-6';

  rl.close();

  const config: CcgConfig = {
    agents: [
      {
        id: agentId,
        name: agentName,
        emoji: '',
        workspace,
        model,
        skills: [],
        allowedTools: [...DEFAULT_ALLOWED_TOOLS],
        maxConcurrentSessions: 4,
      },
    ],
    bindings: [],
    plugins: [],
  };

  await ensureDirectories();
  await saveConfig(config);

  console.log(`\nccgateway initialized at: ${process.env.CCG_HOME || join(homedir(), '.ccgateway')}`);
  console.log(`Agent "${agentId}" created with workspace: ${workspace}`);

  // Install Claude Code /talk skill
  try {
    await installCcgSkill();
    console.log('Claude Code /talk skill installed.');
  } catch {
    console.log('Note: Could not install Claude Code /talk skill (run `ccg install-skill` manually).');
  }

  console.log('\nNext steps:');
  console.log('  ccg agents list     — see your agents');
  console.log('  ccg chat <agent>    — start a chat');
  console.log('  ccg start           — start the daemon');
}

// ── Claude Code skill install/uninstall ────────────────────────────────────

/**
 * Resolve the Claude Code config directory.
 * Uses CLAUDE_CONFIG_DIR env var if set, otherwise defaults to ~/.claude.
 */
function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Resolve the source path for the SKILL.md file shipped with ccgateway.
 * Works from both src/ (dev) and dist/ (installed).
 */
function getSkillSourcePath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Both src/ and dist/ are one level below package root
  return join(__dirname, '..', 'skills', 'talk', 'SKILL.md');
}

/**
 * Install the ccgateway /talk skill into Claude Code's skills directory.
 * Copies skills/talk/SKILL.md → ~/.claude/skills/ccgateway-talk/SKILL.md
 */
export async function installCcgSkill(): Promise<void> {
  const source = getSkillSourcePath();

  if (!existsSync(source)) {
    throw new Error(`Skill source not found: ${source}`);
  }

  const claudeHome = getClaudeConfigDir();
  const targetDir = join(claudeHome, 'skills', 'ccgateway-talk');
  const targetFile = join(targetDir, 'SKILL.md');

  await mkdir(targetDir, { recursive: true });
  await copyFile(source, targetFile);
}

/**
 * Remove the ccgateway /talk skill from Claude Code's skills directory.
 */
export async function uninstallCcgSkill(): Promise<void> {
  const claudeHome = getClaudeConfigDir();
  const targetDir = join(claudeHome, 'skills', 'ccgateway-talk');

  if (existsSync(targetDir)) {
    await rm(targetDir, { recursive: true, force: true });
  }
}
