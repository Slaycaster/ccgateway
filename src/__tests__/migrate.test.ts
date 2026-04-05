import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  migrateFromOpenClaw,
  stripModelPrefix,
  botTokenEnvVar,
} from "../migrate.js";

// ── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let ccgHome: string;
const originalEnv = process.env.CCG_HOME;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccg-migrate-test-"));
  ccgHome = join(tempDir, "ccgateway");
  process.env.CCG_HOME = ccgHome;
});

afterEach(async () => {
  process.env.CCG_HOME = originalEnv;
  await rm(tempDir, { recursive: true, force: true });
});

// ── Helper: create mock openclaw.json ──────────────────────────────────────

function mockOpenClawConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: "/home/user/clawd",
        maxConcurrent: 4,
      },
      list: [
        {
          id: "main",
          default: true,
          identity: {
            name: "Ginger",
            emoji: "\u{1FAD0}",
          },
        },
        {
          id: "salt",
          name: "salt",
          workspace: "/home/user/clawd-salt",
          model: {
            primary: "anthropic/claude-sonnet-4-6",
          },
          identity: {
            name: "Salt",
            emoji: "\u{1F9C2}",
          },
        },
        {
          id: "pepper",
          name: "pepper",
          workspace: "/home/user/clawd-pepper",
          identity: {
            name: "Pepper",
            emoji: "\u{1F336}\uFE0F",
          },
        },
      ],
    },
    bindings: [
      {
        agentId: "salt",
        match: {
          channel: "discord",
          accountId: "salt",
          peer: { kind: "channel", id: "1465736400014938230" },
        },
      },
      {
        agentId: "pepper",
        match: {
          channel: "discord",
          accountId: "pepper",
          peer: { kind: "channel", id: "1465736402502287511" },
        },
      },
      {
        agentId: "main",
        match: {
          channel: "discord",
          accountId: "ginger",
          peer: { kind: "channel", id: "1465736404494455027" },
        },
      },
    ],
    channels: {
      discord: {
        accounts: {
          ginger: { token: "ginger-test-token-123" },
          salt: { token: "salt-test-token-456" },
          pepper: { token: "pepper-test-token-789" },
        },
      },
    },
  };
}

function mockCronJobs() {
  return {
    version: 1,
    jobs: [
      {
        id: "hb-1",
        agentId: "main",
        name: "ginger-heartbeat",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 9,13,17 * * *",
          tz: "Asia/Manila",
        },
      },
      {
        id: "hb-2",
        agentId: "salt",
        name: "salt-heartbeat",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 9,13,17 * * *",
          tz: "Asia/Manila",
        },
      },
      {
        id: "hb-3",
        agentId: "pepper",
        name: "pepper-heartbeat",
        enabled: false,
        schedule: {
          kind: "cron",
          expr: "0 10 * * *",
          tz: "Asia/Manila",
        },
      },
      {
        id: "at-1",
        agentId: "main",
        name: "one-shot-reminder",
        enabled: true,
        schedule: {
          kind: "at",
          at: "2026-02-05T02:00:00.000Z",
        },
      },
    ],
  };
}

async function writeMockFiles(
  ocConfig?: unknown,
  cronJobs?: unknown,
): Promise<string> {
  const openclawDir = join(tempDir, "openclaw");
  await mkdir(openclawDir, { recursive: true });

  const configPath = join(openclawDir, "openclaw.json");
  await writeFile(configPath, JSON.stringify(ocConfig ?? mockOpenClawConfig()), "utf-8");

  if (cronJobs !== undefined) {
    const cronDir = join(openclawDir, "cron");
    await mkdir(cronDir, { recursive: true });
    await writeFile(join(cronDir, "jobs.json"), JSON.stringify(cronJobs), "utf-8");
  }

  return configPath;
}

// ── Tests: stripModelPrefix ─────────────────────────────────────────────────

describe("stripModelPrefix", () => {
  it('strips "anthropic/" prefix', () => {
    expect(stripModelPrefix("anthropic/claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it('strips "anthropic/" from sonnet model', () => {
    expect(stripModelPrefix("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("returns model as-is when no prefix", () => {
    expect(stripModelPrefix("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("handles other prefixes", () => {
    expect(stripModelPrefix("openrouter/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});

// ── Tests: botTokenEnvVar ───────────────────────────────────────────────────

describe("botTokenEnvVar", () => {
  it("generates DISCORD_SALT_TOKEN for salt", () => {
    expect(botTokenEnvVar("salt")).toBe("DISCORD_SALT_TOKEN");
  });

  it("generates DISCORD_GINGER_TOKEN for ginger", () => {
    expect(botTokenEnvVar("ginger")).toBe("DISCORD_GINGER_TOKEN");
  });

  it("generates DISCORD_PEPPER_TOKEN for pepper", () => {
    expect(botTokenEnvVar("pepper")).toBe("DISCORD_PEPPER_TOKEN");
  });

  it("uppercases the account name", () => {
    expect(botTokenEnvVar("myBot")).toBe("DISCORD_MYBOT_TOKEN");
  });
});

// ── Tests: migrateFromOpenClaw ──────────────────────────────────────────────

describe("migrateFromOpenClaw", () => {
  it("throws helpful error when openclaw.json is missing", async () => {
    await expect(
      migrateFromOpenClaw({ configPath: "/nonexistent/path/openclaw.json" }),
    ).rejects.toThrow("OpenClaw config not found");
  });

  it("extracts agents correctly", async () => {
    const configPath = await writeMockFiles();
    await migrateFromOpenClaw({ configPath, dryRun: true });

    // In dry-run mode, no config file is written, but we can verify
    // the function completes without error (the real assertions are
    // in the non-dry-run test below).
  });

  it("writes config file with correct agents on non-dry-run", async () => {
    const configPath = await writeMockFiles(mockOpenClawConfig(), mockCronJobs());
    await migrateFromOpenClaw({ configPath });

    // Verify config was written
    const ccgConfigPath = join(ccgHome, "config.json");
    expect(existsSync(ccgConfigPath)).toBe(true);

    const raw = await readFile(ccgConfigPath, "utf-8");
    const config = JSON.parse(raw);

    // Verify agents
    expect(config.agents).toHaveLength(3);

    const main = config.agents.find((a: { id: string }) => a.id === "main");
    expect(main).toBeDefined();
    expect(main.name).toBe("Ginger");
    expect(main.emoji).toBe("\u{1FAD0}");
    expect(main.workspace).toBe("/home/user/clawd"); // from defaults
    expect(main.model).toBe("claude-opus-4-6"); // stripped anthropic/ prefix

    const salt = config.agents.find((a: { id: string }) => a.id === "salt");
    expect(salt).toBeDefined();
    expect(salt.name).toBe("Salt");
    expect(salt.emoji).toBe("\u{1F9C2}");
    expect(salt.workspace).toBe("/home/user/clawd-salt"); // agent-level override
    expect(salt.model).toBe("claude-sonnet-4-6"); // agent-level model, stripped

    const pepper = config.agents.find((a: { id: string }) => a.id === "pepper");
    expect(pepper).toBeDefined();
    expect(pepper.name).toBe("Pepper");
    expect(pepper.workspace).toBe("/home/user/clawd-pepper");
    expect(pepper.model).toBe("claude-opus-4-6"); // falls back to default
  });

  it("extracts bindings correctly", async () => {
    const configPath = await writeMockFiles(mockOpenClawConfig(), mockCronJobs());
    await migrateFromOpenClaw({ configPath });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.bindings).toHaveLength(3);

    const saltBinding = config.bindings.find((b: { agent: string }) => b.agent === "salt");
    expect(saltBinding).toBeDefined();
    expect(saltBinding.gateway).toBe("discord");
    expect(saltBinding.channel).toBe("1465736400014938230");
    expect(saltBinding.bot).toBe("salt");

    const mainBinding = config.bindings.find((b: { agent: string }) => b.agent === "main");
    expect(mainBinding).toBeDefined();
    expect(mainBinding.bot).toBe("ginger");
  });

  it("extracts heartbeats from cron jobs (enabled cron-type only)", async () => {
    const configPath = await writeMockFiles(mockOpenClawConfig(), mockCronJobs());
    await migrateFromOpenClaw({ configPath });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    // Only enabled cron-type jobs: main and salt heartbeats
    // pepper-heartbeat is disabled, one-shot-reminder is "at" type
    expect(config.heartbeats).toHaveLength(2);

    const mainHb = config.heartbeats.find((h: { agent: string }) => h.agent === "main");
    expect(mainHb).toBeDefined();
    expect(mainHb.cron).toBe("0 9,13,17 * * *");
    expect(mainHb.tz).toBe("Asia/Manila");

    const saltHb = config.heartbeats.find((h: { agent: string }) => h.agent === "salt");
    expect(saltHb).toBeDefined();
  });

  it("dry run does not write files", async () => {
    const configPath = await writeMockFiles();
    await migrateFromOpenClaw({ configPath, dryRun: true });

    const ccgConfigPath = join(ccgHome, "config.json");
    expect(existsSync(ccgConfigPath)).toBe(false);
  });

  it("handles missing cron/jobs.json gracefully", async () => {
    // Write config without cron jobs
    const configPath = await writeMockFiles(mockOpenClawConfig());
    await migrateFromOpenClaw({ configPath });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.heartbeats).toEqual([]);
  });

  it("model name stripping works for various formats", async () => {
    const ocConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          workspace: "/tmp",
        },
        list: [
          {
            id: "a1",
            identity: { name: "Agent1" },
          },
          {
            id: "a2",
            model: { primary: "openrouter/claude-sonnet-4-6" },
            identity: { name: "Agent2" },
          },
          {
            id: "a3",
            model: { primary: "claude-haiku-3-5" },
            identity: { name: "Agent3" },
          },
        ],
      },
      bindings: [],
    };

    const configPath = await writeMockFiles(ocConfig);
    await migrateFromOpenClaw({ configPath });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.agents[0].model).toBe("claude-opus-4-6");
    expect(config.agents[1].model).toBe("claude-sonnet-4-6");
    expect(config.agents[2].model).toBe("claude-haiku-3-5");
  });

  it("creates standard directories on migration", async () => {
    const configPath = await writeMockFiles();
    await migrateFromOpenClaw({ configPath });

    for (const dir of ["agents", "skills", "plugins", "logs"]) {
      expect(existsSync(join(ccgHome, dir))).toBe(true);
    }
  });
});
