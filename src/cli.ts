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

// ── Subcommand stubs ────────────────────────────────────────────────────────

const stubs = [
  { name: "start", desc: "Start the ccgateway daemon" },
  { name: "stop", desc: "Stop the ccgateway daemon" },
  { name: "status", desc: "Show daemon and agent status" },
  // sessions: implemented below
  { name: "send", desc: "Send a message to an agent" },
  { name: "chat", desc: "Interactive chat with an agent" },
  // skills: implemented below
  { name: "heartbeat", desc: "Manage heartbeat schedules" },
  { name: "migrate", desc: "Run database migrations" },
  { name: "init", desc: "Initialize ccgateway configuration" },
] as const;

for (const stub of stubs) {
  program
    .command(stub.name)
    .description(stub.desc)
    .action(() => {
      console.log(`${stub.name}: Not implemented yet`);
    });
}

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

// ── Run ─────────────────────────────────────────────────────────────────────

program.parse();
