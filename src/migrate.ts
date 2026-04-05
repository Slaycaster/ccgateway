import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { saveConfig, ensureDirectories, getCcgHome } from './config.js';
import type { CcgConfig, AgentConfig, BindingConfig, HeartbeatConfig, PluginEntry } from './config.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface MigrateOptions {
  configPath?: string;  // custom openclaw.json path
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
    peer: {
      kind: string;
      id: string;
    };
  };
}

interface OpenClawCronJob {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: string;
    expr?: string;
    tz?: string;
    at?: string;
  };
  [key: string]: unknown;
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
  };
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
 * Migrate from OpenClaw configuration to ccgateway config.
 */
export async function migrateFromOpenClaw(options: MigrateOptions = {}): Promise<void> {
  // 1. Find openclaw.json
  const configFile = options.configPath || join(homedir(), '.openclaw', 'openclaw.json');

  if (!existsSync(configFile)) {
    throw new Error(
      `OpenClaw config not found at: ${configFile}\n` +
      `Specify the path with: ccg migrate openclaw --config <path>`,
    );
  }

  // 2. Read and parse
  const raw = await readFile(configFile, 'utf-8');
  const ocConfig: OpenClawConfig = JSON.parse(raw);

  // 3. Extract agents
  const agents = extractAgents(ocConfig);

  // 4. Extract bindings
  const bindings = extractBindings(ocConfig, agents);

  // 5. Extract bot tokens + generate .env and plugin config
  const { envLines, pluginBots, instructions: tokenInstructions } = extractBotTokens(ocConfig);

  // 6. Extract guild ID for Discord plugin config
  const guildId = extractGuildId(ocConfig);

  // 7. Build Discord gateway plugin entry if we have bots
  const plugins: PluginEntry[] = [];
  if (Object.keys(pluginBots).length > 0) {
    plugins.push({
      name: 'discord-gateway',
      enabled: true,
      config: {
        bots: pluginBots,
        guild: guildId || '',
        allowedUsers: extractAllowedUsers(ocConfig),
        commands: ['/new', '/reset', '/status'],
      },
    });
  }

  // 8. Extract heartbeats from cron/jobs.json
  const cronPath = join(
    options.configPath
      ? join(options.configPath, '..', 'cron', 'jobs.json')
      : join(homedir(), '.openclaw', 'cron', 'jobs.json'),
  );
  const heartbeats = await extractHeartbeats(cronPath);

  // 9. Build ccgateway config
  const ccgConfig: CcgConfig = {
    agents,
    bindings,
    plugins,
    heartbeats,
  };

  // 10. Print summary
  console.log('--- OpenClaw Migration Summary ---');
  console.log(`  Agents:     ${agents.length}`);
  console.log(`  Bindings:   ${bindings.length}`);
  console.log(`  Plugins:    ${plugins.length}`);
  console.log(`  Heartbeats: ${heartbeats.length}`);
  console.log();

  if (agents.length > 0) {
    console.log('Agents:');
    for (const a of agents) {
      console.log(`  ${a.emoji || '-'} ${a.id} (${a.name}) — model: ${a.model}, workspace: ${a.workspace}`);
    }
    console.log();
  }

  if (bindings.length > 0) {
    console.log('Bindings:');
    for (const b of bindings) {
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

  if (heartbeats.length > 0) {
    console.log('Heartbeats:');
    for (const h of heartbeats) {
      console.log(`  ${h.agent}: ${h.cron} (${h.tz})`);
    }
    console.log();
  }

  if (envLines.length > 0) {
    console.log(`Bot tokens found: ${envLines.length}`);
    for (const line of tokenInstructions) {
      console.log(line);
    }
    console.log();
  }

  // 11. Dry run check
  if (options.dryRun) {
    console.log('[dry-run] No files were written.');
    return;
  }

  // 12. Save config, .env, and ensure directories
  await ensureDirectories();
  await saveConfig(ccgConfig);

  const home = getCcgHome();

  // Write .env with actual bot tokens
  if (envLines.length > 0) {
    const envPath = join(home, '.env');
    await writeFile(envPath, envLines.join('\n') + '\n', 'utf-8');
    console.log(`Bot tokens written to: ${envPath}`);
  }

  console.log(`Config written to: ${join(home, 'config.json')}`);
  console.log();
  console.log('To start ccgateway, load the .env first:');
  console.log(`  source ${join(home, '.env')} && ccg start`);
  console.log();
  console.log('Migration complete.');
}

// ── Extraction helpers ──────────────────────────────────────────────────────

function extractAgents(config: OpenClawConfig): AgentConfig[] {
  const list = config.agents?.list;
  if (!list || list.length === 0) return [];

  const defaults = config.agents?.defaults;
  const defaultModel = defaults?.model?.primary || 'claude-sonnet-4-6';
  const defaultWorkspace = defaults?.workspace || homedir();
  const defaultMaxConcurrent = defaults?.maxConcurrent || 4;

  return list.map((agent): AgentConfig => {
    // Determine model: agent-level override or default
    const rawModel = agent.model?.primary || defaultModel;
    const model = stripModelPrefix(rawModel);

    // Determine workspace: agent-level override or default
    const workspace = agent.workspace || defaultWorkspace;

    // Agent name: identity.name or the agent id
    const name = agent.identity?.name || agent.name || agent.id;

    // Emoji
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

function extractBindings(config: OpenClawConfig, agents: AgentConfig[]): BindingConfig[] {
  const bindings: BindingConfig[] = [];
  const seen = new Set<string>();

  // 1. Extract from explicit bindings array
  const ocBindings = config.bindings;
  if (ocBindings) {
    for (const binding of ocBindings) {
      const key = `${binding.match.channel}:${binding.match.peer.id}:${binding.match.accountId}`;
      if (!seen.has(key)) {
        seen.add(key);
        bindings.push({
          agent: binding.agentId,
          gateway: binding.match.channel,
          channel: binding.match.peer.id,
          bot: binding.match.accountId,
        });
      }
    }
  }

  // 2. Extract from channels.discord.accounts.{bot}.guilds.{guild}.channels
  //    This catches channels that aren't in the bindings array
  const accounts = config.channels?.discord?.accounts;
  if (accounts) {
    // Build a map of bot → agent (first matching agent for each bot)
    const botToAgent = new Map<string, string>();
    for (const agent of agents) {
      // Check if any existing binding maps this bot to an agent
      const existing = bindings.find((b) => b.bot === agent.id);
      if (existing) {
        botToAgent.set(agent.id, existing.agent);
      }
    }
    // Also check explicit bindings for bot→agent mapping
    if (ocBindings) {
      for (const b of ocBindings) {
        botToAgent.set(b.match.accountId, b.agentId);
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

interface ExtractedTokens {
  envLines: string[];       // Lines for .env file (VAR=value)
  pluginBots: Record<string, { token: string }>;  // For plugin config ($VAR references)
  instructions: string[];   // Human-readable summary
}

function extractBotTokens(config: OpenClawConfig): ExtractedTokens {
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

function extractGuildId(config: OpenClawConfig): string | undefined {
  const accounts = config.channels?.discord?.accounts;
  if (!accounts) return undefined;
  // Take the first guild ID found across any account
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
  const accounts = config.channels?.discord?.accounts;
  if (!accounts) return [];
  // Collect unique user IDs from all guild user lists
  const users = new Set<string>();
  for (const account of Object.values(accounts)) {
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
  return [...users];
}

async function extractHeartbeats(cronPath: string): Promise<HeartbeatConfig[]> {
  if (!existsSync(cronPath)) return [];

  try {
    const raw = await readFile(cronPath, 'utf-8');
    const data = JSON.parse(raw) as { jobs?: OpenClawCronJob[] };
    const jobs = data.jobs;
    if (!jobs || jobs.length === 0) return [];

    // Only extract enabled cron-type jobs (not one-shot "at" jobs)
    return jobs
      .filter((job) => job.enabled && job.schedule.kind === 'cron' && job.schedule.expr)
      .map((job): HeartbeatConfig => ({
        agent: job.agentId,
        cron: job.schedule.expr!,
        tz: job.schedule.tz || 'UTC',
      }));
  } catch {
    return [];
  }
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
    heartbeats: [],
  };

  await ensureDirectories();
  await saveConfig(config);

  console.log(`\nccgateway initialized at: ${process.env.CCG_HOME || join(homedir(), '.ccgateway')}`);
  console.log(`Agent "${agentId}" created with workspace: ${workspace}`);
  console.log('\nNext steps:');
  console.log('  ccg agents list     — see your agents');
  console.log('  ccg chat <agent>    — start a chat');
  console.log('  ccg start           — start the daemon');
}
