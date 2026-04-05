import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { AgentRegistry } from "./agents.js";
import type { CCSpawner } from "./spawner.js";
import type { HeartbeatConfig } from "./config.js";

// ── Constants ──────────────────────────────────────────────────────────────

const CRON_MARKER_BEGIN = "# BEGIN ccgateway heartbeats";
const CRON_MARKER_END = "# END ccgateway heartbeats";

const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.";

// ── HeartbeatManager ──────────────────────────────────────────────────────

export class HeartbeatManager {
  constructor(
    private agents: AgentRegistry,
    private spawner: CCSpawner,
    private heartbeats: HeartbeatConfig[],
  ) {}

  /**
   * Run a heartbeat for an agent.
   * - If no HEARTBEAT.md exists in the workspace, returns silent.
   * - If the agent responds with "HEARTBEAT_OK", returns silent.
   * - Otherwise returns the response.
   */
  async runHeartbeat(
    agentId: string,
  ): Promise<{ silent: boolean; response?: string }> {
    // 1. Get agent config, validate
    const agent = this.agents.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    // 2. Check if HEARTBEAT.md exists in workspace
    const heartbeatPath = join(agent.workspace, "HEARTBEAT.md");
    if (!existsSync(heartbeatPath)) {
      return { silent: true };
    }

    // 3. Spawn claude --print with heartbeat prompt
    const result = await this.spawner.spawn({
      workspace: agent.workspace,
      message: HEARTBEAT_PROMPT,
      systemPrompt: "",
      model: agent.model,
      allowedTools: agent.allowedTools,
    });

    // 4. Check if response is HEARTBEAT_OK
    const trimmed = result.response.trim();
    if (trimmed === "HEARTBEAT_OK") {
      return { silent: true };
    }

    // 5. Otherwise return the response
    return { silent: false, response: result.response };
  }

  /**
   * Generate crontab lines from heartbeats config.
   * Format: <cron> TZ=<tz> ccg heartbeat run <agent>
   */
  generateCronLines(): string[] {
    return this.heartbeats.map(
      (hb) => `${hb.cron} TZ=${hb.tz} ccg heartbeat run ${hb.agent}`,
    );
  }

  /**
   * Install cron jobs to system crontab.
   * Returns the generated crontab lines (for display).
   */
  installCron(): string {
    const lines = this.generateCronLines();

    if (lines.length === 0) {
      return "(no heartbeats configured)";
    }

    // Read existing crontab
    let existing = "";
    try {
      existing = execSync("crontab -l 2>/dev/null", {
        encoding: "utf-8",
      });
    } catch {
      // No existing crontab — that's fine
    }

    // Remove any existing ccgateway section
    const cleaned = this.removeCcgSection(existing);

    // Build new crontab
    const ccgSection = [
      CRON_MARKER_BEGIN,
      ...lines,
      CRON_MARKER_END,
    ].join("\n");

    const newCrontab = cleaned.trim()
      ? `${cleaned.trim()}\n${ccgSection}\n`
      : `${ccgSection}\n`;

    // Install
    execSync(`echo ${JSON.stringify(newCrontab)} | crontab -`, {
      encoding: "utf-8",
    });

    return lines.join("\n");
  }

  /**
   * Remove ccgateway cron jobs from system crontab.
   */
  uninstallCron(): void {
    let existing = "";
    try {
      existing = execSync("crontab -l 2>/dev/null", {
        encoding: "utf-8",
      });
    } catch {
      return; // No crontab to clean
    }

    const cleaned = this.removeCcgSection(existing);

    if (cleaned.trim() === "") {
      // Remove crontab entirely if empty
      try {
        execSync("crontab -r 2>/dev/null", { encoding: "utf-8" });
      } catch {
        // Already empty
      }
    } else {
      execSync(`echo ${JSON.stringify(cleaned.trim() + "\n")} | crontab -`, {
        encoding: "utf-8",
      });
    }
  }

  /**
   * List configured heartbeats.
   */
  listHeartbeats(): HeartbeatConfig[] {
    return this.heartbeats;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Remove the ccgateway section from crontab content.
   */
  private removeCcgSection(crontab: string): string {
    const lines = crontab.split("\n");
    const result: string[] = [];
    let inSection = false;

    for (const line of lines) {
      if (line.trim() === CRON_MARKER_BEGIN) {
        inSection = true;
        continue;
      }
      if (line.trim() === CRON_MARKER_END) {
        inSection = false;
        continue;
      }
      if (!inSection) {
        result.push(line);
      }
    }

    return result.join("\n");
  }
}
