import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatManager } from "../heartbeat.js";
import { AgentRegistry } from "../agents.js";
import { CCSpawner, type SpawnResult } from "../spawner.js";
import type { CcgConfig, HeartbeatConfig } from "../config.js";

// ── Mock fs for existsSync (HEARTBEAT.md check) ──────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const mockedExistsSync = vi.mocked(existsSync);
const mockedExecSync = vi.mocked(execSync);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(agents: CcgConfig["agents"] = []): CcgConfig {
  return { agents, bindings: [], plugins: [], heartbeats: [] };
}

function makeAgent(id: string) {
  return {
    id,
    name: id,
    emoji: "",
    workspace: `/home/user/${id}`,
    model: "claude-sonnet-4-6",
    skills: [],
    allowedTools: ["Read", "Write"],
    maxConcurrentSessions: 4,
  };
}

function makeSpawnResult(response: string): SpawnResult {
  return {
    response,
    exitCode: 0,
    tokensEstimate: { in: 10, out: Math.ceil(response.length / 4) },
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

let registry: AgentRegistry;
let spawner: CCSpawner;

beforeEach(() => {
  vi.clearAllMocks();
  const config = makeConfig([makeAgent("ginger"), makeAgent("salt")]);
  registry = new AgentRegistry(config);
  spawner = new CCSpawner();

  // Default: workspace directory exists (AgentRegistry.validateWorkspace uses existsSync)
  // We need existsSync to return true for workspace paths, but control HEARTBEAT.md separately
  mockedExistsSync.mockImplementation((path: any) => {
    const p = String(path);
    // Agent workspaces exist
    if (p === "/home/user/ginger" || p === "/home/user/salt") return true;
    // HEARTBEAT.md — default to false, override in tests
    return false;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── runHeartbeat tests ────────────────────────────────────────────────────

describe("runHeartbeat", () => {
  it("returns silent when no HEARTBEAT.md exists", async () => {
    const manager = new HeartbeatManager(registry, spawner, []);

    mockedExistsSync.mockImplementation((path: any) => {
      const p = String(path);
      if (p.endsWith("HEARTBEAT.md")) return false;
      return true;
    });

    const result = await manager.runHeartbeat("ginger");
    expect(result).toEqual({ silent: true });
  });

  it("returns silent when agent responds HEARTBEAT_OK", async () => {
    const manager = new HeartbeatManager(registry, spawner, []);

    mockedExistsSync.mockImplementation(() => true);

    vi.spyOn(spawner, "spawn").mockResolvedValue(
      makeSpawnResult("HEARTBEAT_OK"),
    );

    const result = await manager.runHeartbeat("ginger");
    expect(result).toEqual({ silent: true });
  });

  it("returns response when agent has actual output", async () => {
    const manager = new HeartbeatManager(registry, spawner, []);

    mockedExistsSync.mockImplementation(() => true);

    vi.spyOn(spawner, "spawn").mockResolvedValue(
      makeSpawnResult("There are 3 pending PRs that need review."),
    );

    const result = await manager.runHeartbeat("ginger");
    expect(result.silent).toBe(false);
    expect(result.response).toBe(
      "There are 3 pending PRs that need review.",
    );
  });

  it("throws for unknown agent", async () => {
    const manager = new HeartbeatManager(registry, spawner, []);

    await expect(manager.runHeartbeat("unknown")).rejects.toThrow(
      'Agent "unknown" not found',
    );
  });

  it("passes correct options to spawner", async () => {
    const manager = new HeartbeatManager(registry, spawner, []);

    mockedExistsSync.mockImplementation(() => true);

    const spawnSpy = vi
      .spyOn(spawner, "spawn")
      .mockResolvedValue(makeSpawnResult("HEARTBEAT_OK"));

    await manager.runHeartbeat("ginger");

    expect(spawnSpy).toHaveBeenCalledWith({
      workspace: "/home/user/ginger",
      message:
        "Read HEARTBEAT.md. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.",
      systemPrompt: "",
      model: "claude-sonnet-4-6",
      allowedTools: ["Read", "Write"],
    });
  });
});

// ── generateCronLines tests ──────────────────────────────────────────────

describe("generateCronLines", () => {
  it("generates correct crontab format", () => {
    const heartbeats: HeartbeatConfig[] = [
      { agent: "ginger", cron: "0 9,17 * * *", tz: "Asia/Manila" },
      { agent: "salt", cron: "0 8 * * 1-5", tz: "America/New_York" },
    ];

    const manager = new HeartbeatManager(registry, spawner, heartbeats);
    const lines = manager.generateCronLines();

    expect(lines).toEqual([
      "0 9,17 * * * TZ=Asia/Manila ccg heartbeat run ginger",
      "0 8 * * 1-5 TZ=America/New_York ccg heartbeat run salt",
    ]);
  });

  it("returns empty array when no heartbeats configured", () => {
    const manager = new HeartbeatManager(registry, spawner, []);
    const lines = manager.generateCronLines();
    expect(lines).toEqual([]);
  });
});

// ── listHeartbeats tests ─────────────────────────────────────────────────

describe("listHeartbeats", () => {
  it("returns configured heartbeats", () => {
    const heartbeats: HeartbeatConfig[] = [
      { agent: "ginger", cron: "0 9 * * *", tz: "Asia/Manila" },
    ];

    const manager = new HeartbeatManager(registry, spawner, heartbeats);
    expect(manager.listHeartbeats()).toEqual(heartbeats);
  });

  it("returns empty array when none configured", () => {
    const manager = new HeartbeatManager(registry, spawner, []);
    expect(manager.listHeartbeats()).toEqual([]);
  });
});

// ── installCron tests ────────────────────────────────────────────────────

describe("installCron", () => {
  it("returns message when no heartbeats configured", () => {
    const manager = new HeartbeatManager(registry, spawner, []);
    const result = manager.installCron();
    expect(result).toBe("(no heartbeats configured)");
  });

  it("installs cron entries with markers", () => {
    const heartbeats: HeartbeatConfig[] = [
      { agent: "ginger", cron: "0 9,17 * * *", tz: "Asia/Manila" },
    ];

    // No existing crontab
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("crontab -l")) {
        throw new Error("no crontab");
      }
      return "" as any;
    });

    const manager = new HeartbeatManager(registry, spawner, heartbeats);
    const result = manager.installCron();

    expect(result).toBe(
      "0 9,17 * * * TZ=Asia/Manila ccg heartbeat run ginger",
    );

    // Verify crontab was written
    const installCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("| crontab -"),
    );
    expect(installCall).toBeDefined();
  });
});
