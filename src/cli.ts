#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  { name: "agents", desc: "Manage agents" },
  { name: "sessions", desc: "Manage sessions" },
  { name: "send", desc: "Send a message to an agent" },
  { name: "chat", desc: "Interactive chat with an agent" },
  { name: "skills", desc: "Manage skills" },
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

// ── Run ─────────────────────────────────────────────────────────────────────

program.parse();
