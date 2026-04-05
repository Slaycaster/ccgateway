import { loadConfig, getCcgHome, ensureDirectories } from './config.js';
import { AgentRegistry } from './agents.js';
import { SessionManager } from './sessions.js';
import { SkillManager } from './skills.js';
import { ContextBuilder } from './context.js';
import { CCSpawner } from './spawner.js';
import { MessageRouter } from './router.js';
import { PluginLoader } from './plugin.js';
import type { CcgCore, CcgPlugin } from './plugin.js';
import { CrossAgentMessenger } from './messaging.js';
import { createIpcServer, socketPath } from './ipc.js';
import { configureLogger, logger } from './logger.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Built-in plugin factories
import createDiscordGateway from './plugins/discord-gateway.js';
import createSlackGateway from './plugins/slack-gateway.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUILTIN_PLUGINS: Record<string, (config: any) => CcgPlugin> = {
  'discord-gateway': createDiscordGateway,
  'slack-gateway': createSlackGateway,
};

/**
 * Start the ccgateway daemon (foreground).
 *
 * 1. Loads config and ensures directory structure
 * 2. Builds core components (AgentRegistry, SessionManager, etc.)
 * 3. Loads and starts all enabled plugins
 * 4. Writes PID file for lifecycle management
 * 5. Sets up signal handlers for graceful shutdown
 */
export async function startDaemon(): Promise<void> {
  // 1. Load config
  const config = await loadConfig();

  // 2. Ensure directories
  await ensureDirectories();

  // 3. Enable file logging for daemon mode
  configureLogger({ file: true });

  // 4. Create core components
  const ccgHome = getCcgHome();
  const registry = new AgentRegistry(config);
  const sessions = new SessionManager(ccgHome);
  const skills = new SkillManager(ccgHome);
  const context = new ContextBuilder(sessions, skills, ccgHome, registry);
  const spawner = new CCSpawner();
  const router = new MessageRouter(
    registry,
    sessions,
    context,
    spawner,
    config.bindings,
  );

  // 5. Create PluginLoader and messenger (messenger needs loader reference)
  const loader = new PluginLoader();
  const messenger = new CrossAgentMessenger(
    registry,
    config.bindings,
    loader,
    ccgHome,
  );
  messenger.setRouter(router);

  // 6. Build CcgCore object for plugins
  const core: CcgCore = {
    config,
    agents: registry,
    sessions,
    router,
    async send(agentId: string, message: string, fromAgent?: string): Promise<void> {
      await messenger.send(agentId, message, fromAgent);
    },
  };

  // 7. Load built-in plugins + any external plugins
  for (const entry of config.plugins) {
    if (!entry.enabled) continue;

    let plugin: CcgPlugin;
    const builtinFactory = BUILTIN_PLUGINS[entry.name];
    if (builtinFactory) {
      plugin = builtinFactory(entry.config);
    } else {
      // Fall back to generic import for external plugins
      await loader.loadPlugins({ ...config, plugins: [entry] }, core);
      continue;
    }

    await plugin.init(core);
    loader.registerPlugin(plugin);
    logger.info(`plugin: loaded built-in "${plugin.name}" (type=${plugin.type})`);
  }

  // 8. Start all plugins
  await loader.startAll();

  // 9. Start IPC server for cross-agent messaging from CLI
  const ipcServer = createIpcServer(async (toAgent, content, fromAgent) => {
    await messenger.send(toAgent, content, fromAgent);
  });

  // 10. Write PID file
  const pid = process.pid;
  writeFileSync(pidPath(), String(pid), 'utf-8');

  // 11. Set up signal handlers for graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`ccgateway received ${signal}, shutting down...`);
    try {
      ipcServer.close();
      removeSocketFile();
    } catch { /* non-fatal */ }
    try {
      await loader.stopAll();
    } catch (err) {
      logger.error(`Error stopping plugins: ${(err as Error).message}`);
    }
    removePidFile();
    logger.info('ccgateway stopped.');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // 12. Log startup
  const agentCount = registry.listAgents().length;
  const pluginCount = loader.getPlugins().length;
  logger.info(
    `ccgateway started (pid=${pid}, agents=${agentCount}, plugins=${pluginCount})`,
  );
  console.log(
    `ccgateway started (pid=${pid}, agents=${agentCount}, plugins=${pluginCount})`,
  );

  // 13. Keep process alive — plugins maintain connections via event loops.
  // If no plugins are keeping the event loop alive, use a heartbeat interval.
  const keepAlive = setInterval(() => {
    // no-op: keeps the event loop alive
  }, 60_000);
  keepAlive.unref(); // allow process to exit if all plugins stop
}

/**
 * Stop the running ccgateway daemon.
 *
 * Reads the PID file, sends SIGTERM, waits briefly, then SIGKILL if needed.
 */
export function stopDaemon(): void {
  const path = pidPath();

  if (!existsSync(path)) {
    console.error('ccgateway is not running (no PID file found).');
    process.exitCode = 1;
    return;
  }

  const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);

  if (isNaN(pid)) {
    console.error('Invalid PID file. Removing it.');
    removePidFile();
    process.exitCode = 1;
    return;
  }

  // Check if process is actually running
  if (!isProcessRunning(pid)) {
    console.log('ccgateway process is not running. Cleaning up stale PID file.');
    removePidFile();
    return;
  }

  // Send SIGTERM for graceful shutdown
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to ccgateway (pid=${pid}).`);
  } catch {
    console.error(`Failed to send SIGTERM to pid ${pid}. Removing stale PID file.`);
    removePidFile();
    process.exitCode = 1;
    return;
  }

  // Wait briefly and check if still running, then SIGKILL
  setTimeout(() => {
    if (isProcessRunning(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`Process did not exit gracefully. Sent SIGKILL to pid=${pid}.`);
      } catch {
        // Process may have exited between check and kill
      }
    }
    removePidFile();
  }, 3000);
}

/**
 * Get the status of the ccgateway daemon.
 */
export function getDaemonStatus(): { running: boolean; pid?: number; uptime?: number } {
  const path = pidPath();

  if (!existsSync(path)) {
    return { running: false };
  }

  const raw = readFileSync(path, 'utf-8').trim();
  const pid = parseInt(raw, 10);

  if (isNaN(pid)) {
    return { running: false };
  }

  if (!isProcessRunning(pid)) {
    return { running: false, pid };
  }

  // Estimate uptime from PID file modification time
  const { mtimeMs } = statSync(path);
  const uptime = Math.floor((Date.now() - mtimeMs) / 1000);

  return { running: true, pid, uptime };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the PID file path. */
export function pidPath(): string {
  return join(getCcgHome(), 'ccgateway.pid');
}

/** Check if a process is running. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove the Unix socket file if it exists. */
function removeSocketFile(): void {
  const path = socketPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore removal errors
    }
  }
}

/** Remove the PID file if it exists. */
function removePidFile(): void {
  const path = pidPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore removal errors
    }
  }
}
