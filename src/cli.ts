#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadConfig, saveConfig, getCcgHome } from "./config.js";
import type { AgentConfig } from "./config.js";
import { AgentRegistry } from "./agents.js";
import { SessionManager } from "./sessions.js";
import { SkillManager } from "./skills.js";
import { ContextBuilder } from "./context.js";
import { CCSpawner } from "./spawner.js";
import { startChat } from "./chat.js";
import { HeartbeatManager } from "./heartbeat.js";
import { CrossAgentMessenger } from "./messaging.js";
import { PluginLoader } from "./plugin.js";
import { startDaemon, stopDaemon, getDaemonStatus } from "./daemon.js";
import { migrateFromOpenClaw, initNew } from "./migrate.js";

// ── Read version from package.json ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In dev (src/cli.ts) the package.json is one level up; in dist (dist/cli.js) also one level up.
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

// ── Build CLI ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("ccg")
  .description("ccgateway — multi-agent orchestration layer for Claude Code")
  .version(pkg.version);

// ── send command ────────────────────────────────────────────────────────────

program
  .command("send <agent> <message>")
  .description("Send a message to an agent's primary channel")
  .option("--direct", "Force file-based inbox delivery")
  .option("--from <agentId>", "Specify sender agent id")
  .action(async (agent: string, message: string, opts: { direct?: boolean; from?: string }) => {
    try {
      const config = await loadConfig();
      const ccgHome = getCcgHome();
      const registry = new AgentRegistry(config);
      const loader = new PluginLoader();
      const messenger = new CrossAgentMessenger(
        registry,
        config.bindings,
        loader,
        ccgHome,
      );

      if (opts.direct) {
        await messenger.sendToInbox(agent, message, opts.from);
        console.log(`Message delivered to ${agent}'s inbox.`);
      } else {
        await messenger.send(agent, message, opts.from);
        console.log(`Message sent to ${agent}.`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// ── start / stop / status ───────────────────────────────────────────────────

program
  .command("start")
  .description("Start the ccgateway daemon (foreground)")
  .action(async () => {
    try {
      await startDaemon();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("stop")
  .description("Stop the running ccgateway daemon")
  .action(() => {
    stopDaemon();
  });

program
  .command("status")
  .description("Show daemon status, PID, and connected gateways")
  .action(() => {
    const status = getDaemonStatus();

    if (!status.running) {
      console.log("ccgateway is not running.");
      if (status.pid) {
        console.log(`  Stale PID file references pid=${status.pid}`);
      }
      return;
    }

    console.log("ccgateway is running.");
    console.log(`  PID:    ${status.pid}`);
    if (status.uptime !== undefined) {
      const hours = Math.floor(status.uptime / 3600);
      const mins = Math.floor((status.uptime % 3600) / 60);
      const secs = status.uptime % 60;
      console.log(`  Uptime: ${hours}h ${mins}m ${secs}s`);
    }
  });

// ── migrate subcommand ──────────────────────────────────────────────────────

const migrateCmd = program
  .command("migrate")
  .description("Migrate configuration from another system");

migrateCmd
  .command("openclaw")
  .description("Migrate from OpenClaw configuration")
  .option("--config <path...>", "Path(s) to openclaw.json (repeatable)")
  .option("--dry-run", "Preview migration without writing files")
  .action(async (opts) => {
    try {
      await migrateFromOpenClaw({
        configPaths: opts.config,
        dryRun: opts.dryRun,
      });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// ── init subcommand ─────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize ccgateway configuration interactively")
  .action(async () => {
    try {
      await initNew();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// ── chat subcommand ───────────────────────────────────────────────────────

program
  .command("chat <agent>")
  .description("Start interactive chat REPL with an agent")
  .action(async (agentId: string) => {
    const config = await loadConfig();
    const ccgHome = getCcgHome();
    const registry = new AgentRegistry(config);
    const sessions = new SessionManager(ccgHome);
    const skills = new SkillManager(ccgHome);
    const context = new ContextBuilder(sessions, skills, ccgHome, registry);
    const spawner = new CCSpawner();

    try {
      await startChat(agentId, registry, sessions, context, spawner);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// ── heartbeat subcommand ─────────────────────────────────────────────────

const heartbeatCmd = program
  .command("heartbeat")
  .description("Manage heartbeat schedules");

heartbeatCmd
  .command("install")
  .description("Install cron jobs for heartbeats")
  .action(async () => {
    const config = await loadConfig();
    const registry = new AgentRegistry(config);
    const spawner = new CCSpawner();
    const manager = new HeartbeatManager(registry, spawner, config.heartbeats);

    try {
      const lines = manager.installCron();
      console.log("Installed heartbeat cron jobs:");
      console.log(lines);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

heartbeatCmd
  .command("uninstall")
  .description("Remove heartbeat cron jobs")
  .action(async () => {
    const config = await loadConfig();
    const registry = new AgentRegistry(config);
    const spawner = new CCSpawner();
    const manager = new HeartbeatManager(registry, spawner, config.heartbeats);

    try {
      manager.uninstallCron();
      console.log("Heartbeat cron jobs removed.");
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

heartbeatCmd
  .command("list")
  .description("List configured heartbeats")
  .action(async () => {
    const config = await loadConfig();
    const registry = new AgentRegistry(config);
    const spawner = new CCSpawner();
    const manager = new HeartbeatManager(registry, spawner, config.heartbeats);
    const heartbeats = manager.listHeartbeats();

    if (heartbeats.length === 0) {
      console.log("No heartbeats configured.");
      return;
    }

    const header = ["Agent", "Cron", "Timezone"];
    const rows = heartbeats.map((hb) => [hb.agent, hb.cron, hb.tz]);

    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );

    const formatRow = (cols: string[]) =>
      cols.map((c, i) => c.padEnd(widths[i])).join("  ");

    console.log(formatRow(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  });

heartbeatCmd
  .command("run <agent>")
  .description("Run heartbeat for an agent manually")
  .action(async (agentId: string) => {
    const config = await loadConfig();
    const registry = new AgentRegistry(config);
    const spawner = new CCSpawner();
    const manager = new HeartbeatManager(registry, spawner, config.heartbeats);

    try {
      const result = await manager.runHeartbeat(agentId);

      if (result.silent) {
        console.log(`Heartbeat for "${agentId}": all clear.`);
      } else {
        console.log(`Heartbeat for "${agentId}":`);
        console.log(result.response);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// ── agents subcommand ──────────────────────────────────────────────────────

const agentsCmd = program
  .command("agents")
  .description("Manage agents");

agentsCmd
  .command("list")
  .description("List all agents")
  .action(async () => {
    const config = await loadConfig();
    const registry = new AgentRegistry(config);
    const agents = registry.listAgents();

    if (agents.length === 0) {
      console.log("No agents configured.");
      return;
    }

    // Table header
    const header = ["ID", "Name", "Emoji", "Workspace", "Model"];
    const rows = agents.map((a) => [
      a.id,
      a.name,
      a.emoji || "(none)",
      a.workspace,
      a.model,
    ]);

    // Calculate column widths
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );

    const formatRow = (cols: string[]) =>
      cols.map((c, i) => c.padEnd(widths[i])).join("  ");

    console.log(formatRow(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  });

agentsCmd
  .command("add")
  .description("Add an agent")
  .requiredOption("--id <id>", "Agent id")
  .requiredOption("--name <name>", "Agent name")
  .requiredOption("--workspace <path>", "Workspace directory path")
  .option("--model <model>", "Model to use", "claude-sonnet-4-6")
  .option("--emoji <emoji>", "Emoji for the agent", "")
  .option("--skills <skills...>", "Skills list", [])
  .option(
    "--allowedTools <tools...>",
    "Allowed tools list",
    ["Edit", "Read", "Write", "Bash", "Grep", "Glob"],
  )
  .option(
    "--maxConcurrentSessions <n>",
    "Max concurrent sessions",
    "4",
  )
  .action(async (opts) => {
    const workspacePath = resolve(opts.workspace);

    if (!existsSync(workspacePath)) {
      console.error(`Error: Workspace directory does not exist: ${workspacePath}`);
      process.exitCode = 1;
      return;
    }

    const config = await loadConfig();
    const registry = new AgentRegistry(config);

    const agent: AgentConfig = {
      id: opts.id,
      name: opts.name,
      emoji: opts.emoji,
      workspace: workspacePath,
      model: opts.model,
      skills: opts.skills,
      allowedTools: opts.allowedTools,
      maxConcurrentSessions: parseInt(opts.maxConcurrentSessions, 10),
    };

    try {
      registry.addAgent(agent);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    config.agents = registry.listAgents();
    await saveConfig(config);
    console.log(`Agent "${agent.id}" added.`);
  });

agentsCmd
  .command("remove <id>")
  .description("Remove an agent")
  .action(async (id: string) => {
    const config = await loadConfig();
    const registry = new AgentRegistry(config);

    if (!registry.removeAgent(id)) {
      console.error(`Error: Agent "${id}" not found.`);
      process.exitCode = 1;
      return;
    }

    config.agents = registry.listAgents();
    await saveConfig(config);
    console.log(`Agent "${id}" removed.`);
  });

agentsCmd
  .command("info <id>")
  .description("Show full agent config and workspace validation")
  .action(async (id: string) => {
    const config = await loadConfig();
    const registry = new AgentRegistry(config);
    const agent = registry.getAgent(id);

    if (!agent) {
      console.error(`Error: Agent "${id}" not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Agent: ${agent.name} (${agent.id})`);
    console.log(`  Emoji:                 ${agent.emoji || "(none)"}`);
    console.log(`  Workspace:             ${agent.workspace}`);
    console.log(`  Model:                 ${agent.model}`);
    console.log(`  Skills:                ${agent.skills.length > 0 ? agent.skills.join(", ") : "(none)"}`);
    console.log(`  Allowed tools:         ${agent.allowedTools.join(", ")}`);
    console.log(`  Max concurrent:        ${agent.maxConcurrentSessions}`);

    const validation = registry.validateWorkspace(id);
    if (validation.valid) {
      console.log(`  Workspace validation:  OK`);
    } else {
      console.log(`  Workspace validation:  FAILED`);
      for (const err of validation.errors) {
        console.log(`    - ${err}`);
      }
    }
  });

// ── sessions subcommand ───────────────────────────────────────────────────

const sessionsCmd = program
  .command("sessions")
  .description("Manage sessions");

sessionsCmd
  .command("list")
  .description("List sessions with agent, key, message count, last activity")
  .option("--agent <id>", "Filter by agent id")
  .action(async (opts) => {
    const mgr = new SessionManager(getCcgHome());
    const sessions = await mgr.listSessions(opts.agent);

    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    const header = ["Agent", "Session Key", "Messages", "Last Activity"];
    const rows = sessions.map((s) => [
      s.agentId,
      s.sessionKey,
      String(s.messageCount),
      new Date(s.lastActivity).toISOString(),
    ]);

    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );

    const formatRow = (cols: string[]) =>
      cols.map((c, i) => c.padEnd(widths[i])).join("  ");

    console.log(formatRow(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  });

sessionsCmd
  .command("inspect <sessionKey>")
  .description("Show messages in a session (most recent 20)")
  .action(async (sessionKey: string) => {
    const parts = sessionKey.split(":");
    if (parts.length < 3) {
      console.error("Error: Session key must be in format agentId:source:sourceId");
      process.exitCode = 1;
      return;
    }

    const agentId = parts[0];
    const mgr = new SessionManager(getCcgHome());
    const messages = await mgr.readHistory(agentId, sessionKey);

    if (messages.length === 0) {
      console.log("No messages found for this session.");
      return;
    }

    // Show the most recent 20 messages
    const recent = messages.slice(-20);
    const skipped = messages.length - recent.length;

    if (skipped > 0) {
      console.log(`... ${skipped} older message(s) omitted ...\n`);
    }

    for (const msg of recent) {
      const time = new Date(msg.ts).toISOString();
      const src = msg.source ? ` [${msg.source}]` : "";
      const user = msg.sourceUser ? ` (${msg.sourceUser})` : "";
      console.log(`[${time}] ${msg.role}${src}${user}:`);
      console.log(`  ${msg.content}`);
      console.log();
    }
  });

sessionsCmd
  .command("reset <sessionKey>")
  .description("Archive and reset a session")
  .action(async (sessionKey: string) => {
    const parts = sessionKey.split(":");
    if (parts.length < 3) {
      console.error("Error: Session key must be in format agentId:source:sourceId");
      process.exitCode = 1;
      return;
    }

    const agentId = parts[0];
    const mgr = new SessionManager(getCcgHome());
    await mgr.resetSession(agentId, sessionKey);
    console.log(`Session "${sessionKey}" has been archived and reset.`);
  });

// ── skills subcommand ────────────────────────────────────────────────────

const skillsCmd = program
  .command("skills")
  .description("Manage skills");

skillsCmd
  .command("list")
  .description("List all skills (name, description, type, scope)")
  .option("--agent <id>", "Filter by agent id")
  .action(async (opts) => {
    const mgr = new SkillManager(getCcgHome());
    const skills = await mgr.listSkills(opts.agent);

    if (skills.length === 0) {
      console.log("No skills found.");
      return;
    }

    const header = ["Name", "Description", "Type", "Scope"];
    const rows = skills.map((s) => [
      s.name,
      s.description,
      s.type,
      s.agentId ? `agent:${s.agentId}` : "shared",
    ]);

    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );

    const formatRow = (cols: string[]) =>
      cols.map((c, i) => c.padEnd(widths[i])).join("  ");

    console.log(formatRow(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  });

skillsCmd
  .command("add <file>")
  .description("Add a skill (copy .md file to skills directory)")
  .option("--agent <id>", "Add to agent-specific skills")
  .action(async (file: string, opts) => {
    const filePath = resolve(file);

    if (!existsSync(filePath)) {
      console.error(`Error: File does not exist: ${filePath}`);
      process.exitCode = 1;
      return;
    }

    if (!filePath.endsWith(".md")) {
      console.error("Error: Skill file must be a .md file");
      process.exitCode = 1;
      return;
    }

    const mgr = new SkillManager(getCcgHome());
    await mgr.addSkill(filePath, opts.agent);

    const scope = opts.agent ? `agent:${opts.agent}` : "shared";
    console.log(`Skill added to ${scope} skills.`);
  });

skillsCmd
  .command("remove <name>")
  .description("Remove a skill")
  .option("--agent <id>", "Remove from agent-specific skills")
  .action(async (name: string, opts) => {
    const mgr = new SkillManager(getCcgHome());
    const removed = await mgr.removeSkill(name, opts.agent);

    if (!removed) {
      console.error(`Error: Skill "${name}" not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Skill "${name}" removed.`);
  });

// ── Run ─────────────────────────────────────────────────────────────────────

program.parse();
