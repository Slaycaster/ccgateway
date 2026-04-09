import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  migrateFromOpenClaw,
  stripModelPrefix,
  botTokenEnvVar,
  slackTokenEnvVars,
  deriveInstanceName,
  resolveCollisions,
  installCcgSkill,
  uninstallCcgSkill,
} from "../migrate.js";
import type { AgentConfig } from "../config.js";

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

// ── Helper: create mock openclaw instances ──────────────────────────────────

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

/** Write a single mock openclaw instance and return its config path. */
async function writeMockFiles(
  ocConfig?: unknown,
): Promise<string> {
  const openclawDir = join(tempDir, "openclaw");
  await mkdir(openclawDir, { recursive: true });

  const configPath = join(openclawDir, "openclaw.json");
  await writeFile(configPath, JSON.stringify(ocConfig ?? mockOpenClawConfig()), "utf-8");

  return configPath;
}

/**
 * Write a named mock openclaw instance under tempDir/.openclaw-{name}/
 * or tempDir/.openclaw/ for the default instance.
 */
async function writeNamedInstance(
  name: string,
  ocConfig: unknown,
): Promise<string> {
  const dirName = name === "openclaw" ? ".openclaw" : `.openclaw-${name}`;
  const dir = join(tempDir, dirName);
  await mkdir(dir, { recursive: true });

  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify(ocConfig), "utf-8");

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

// ── Tests: slackTokenEnvVars ────────────────────────────────────────────────

describe("slackTokenEnvVars", () => {
  it("generates correct env var names for default", () => {
    const vars = slackTokenEnvVars("default");
    expect(vars.token).toBe("SLACK_DEFAULT_TOKEN");
    expect(vars.appToken).toBe("SLACK_DEFAULT_APP_TOKEN");
  });

  it("generates correct env var names for vilma", () => {
    const vars = slackTokenEnvVars("vilma");
    expect(vars.token).toBe("SLACK_VILMA_TOKEN");
    expect(vars.appToken).toBe("SLACK_VILMA_APP_TOKEN");
  });

  it("uppercases the bot name", () => {
    const vars = slackTokenEnvVars("myBot");
    expect(vars.token).toBe("SLACK_MYBOT_TOKEN");
    expect(vars.appToken).toBe("SLACK_MYBOT_APP_TOKEN");
  });
});

// ── Tests: deriveInstanceName ───────────────────────────────────────────────

describe("deriveInstanceName", () => {
  it('derives "openclaw" from ~/.openclaw/openclaw.json', () => {
    expect(deriveInstanceName("/home/user/.openclaw/openclaw.json")).toBe("openclaw");
  });

  it('derives "sentri" from ~/.openclaw-sentri/openclaw.json', () => {
    expect(deriveInstanceName("/home/user/.openclaw-sentri/openclaw.json")).toBe("sentri");
  });

  it('derives "fpj" from ~/.openclaw-fpj/openclaw.json', () => {
    expect(deriveInstanceName("/home/user/.openclaw-fpj/openclaw.json")).toBe("fpj");
  });

  it("handles non-dot directory", () => {
    expect(deriveInstanceName("/tmp/testdir/openclaw.json")).toBe("testdir");
  });
});

// ── Tests: resolveCollisions ────────────────────────────────────────────────

describe("resolveCollisions", () => {
  it("does not rename unique agent IDs", () => {
    const instanceAgents = [
      {
        instanceName: "openclaw",
        agents: [{ id: "ginger" } as AgentConfig],
      },
      {
        instanceName: "sentri",
        agents: [{ id: "vilma" } as AgentConfig],
      },
    ];

    const { renames, summary } = resolveCollisions(instanceAgents);

    expect(renames.get("openclaw:ginger")).toBe("ginger");
    expect(renames.get("sentri:vilma")).toBe("vilma");
    expect(summary).toHaveLength(0);
    expect(instanceAgents[0].agents[0].id).toBe("ginger");
    expect(instanceAgents[1].agents[0].id).toBe("vilma");
  });

  it("renames colliding agent IDs with instance prefix", () => {
    const instanceAgents = [
      {
        instanceName: "openclaw",
        agents: [{ id: "main" } as AgentConfig],
      },
      {
        instanceName: "sentri",
        agents: [{ id: "main" } as AgentConfig],
      },
    ];

    const { renames, summary } = resolveCollisions(instanceAgents);

    expect(renames.get("openclaw:main")).toBe("openclaw-main");
    expect(renames.get("sentri:main")).toBe("sentri-main");
    expect(summary).toHaveLength(2);
    expect(instanceAgents[0].agents[0].id).toBe("openclaw-main");
    expect(instanceAgents[1].agents[0].id).toBe("sentri-main");
  });

  it("only renames colliding IDs — unique IDs stay untouched", () => {
    const instanceAgents = [
      {
        instanceName: "openclaw",
        agents: [
          { id: "main" } as AgentConfig,
          { id: "ginger" } as AgentConfig,
        ],
      },
      {
        instanceName: "sentri",
        agents: [
          { id: "main" } as AgentConfig,
          { id: "vilma" } as AgentConfig,
        ],
      },
    ];

    const { renames } = resolveCollisions(instanceAgents);

    expect(renames.get("openclaw:main")).toBe("openclaw-main");
    expect(renames.get("sentri:main")).toBe("sentri-main");
    expect(renames.get("openclaw:ginger")).toBe("ginger");
    expect(renames.get("sentri:vilma")).toBe("vilma");
  });
});

// ── Tests: migrateFromOpenClaw (single instance) ──────────────────────────

describe("migrateFromOpenClaw", () => {
  it("throws helpful error when openclaw.json is missing", async () => {
    await expect(
      migrateFromOpenClaw({ configPaths: ["/nonexistent/path/openclaw.json"] }),
    ).rejects.toThrow("OpenClaw config not found");
  });

  it("extracts agents correctly (dry-run)", async () => {
    const configPath = await writeMockFiles();
    await migrateFromOpenClaw({ configPaths: [configPath], dryRun: true });
    // Completes without error
  });

  it("writes config file with correct agents on non-dry-run", async () => {
    const configPath = await writeMockFiles(mockOpenClawConfig());
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const ccgConfigPath = join(ccgHome, "config.json");
    expect(existsSync(ccgConfigPath)).toBe(true);

    const raw = await readFile(ccgConfigPath, "utf-8");
    const config = JSON.parse(raw);

    expect(config.agents).toHaveLength(3);

    const main = config.agents.find((a: { id: string }) => a.id === "main");
    expect(main).toBeDefined();
    expect(main.name).toBe("Ginger");
    expect(main.emoji).toBe("\u{1FAD0}");
    expect(main.workspace).toBe("/home/user/clawd");
    expect(main.model).toBe("claude-opus-4-6");

    const salt = config.agents.find((a: { id: string }) => a.id === "salt");
    expect(salt).toBeDefined();
    expect(salt.name).toBe("Salt");
    expect(salt.emoji).toBe("\u{1F9C2}");
    expect(salt.workspace).toBe("/home/user/clawd-salt");
    expect(salt.model).toBe("claude-sonnet-4-6");

    const pepper = config.agents.find((a: { id: string }) => a.id === "pepper");
    expect(pepper).toBeDefined();
    expect(pepper.name).toBe("Pepper");
    expect(pepper.workspace).toBe("/home/user/clawd-pepper");
    expect(pepper.model).toBe("claude-opus-4-6");
  });

  it("extracts bindings correctly", async () => {
    const configPath = await writeMockFiles(mockOpenClawConfig());
    await migrateFromOpenClaw({ configPaths: [configPath] });

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

  it("dry run does not write files", async () => {
    const configPath = await writeMockFiles();
    await migrateFromOpenClaw({ configPaths: [configPath], dryRun: true });

    const ccgConfigPath = join(ccgHome, "config.json");
    expect(existsSync(ccgConfigPath)).toBe(false);
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
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.agents[0].model).toBe("claude-opus-4-6");
    expect(config.agents[1].model).toBe("claude-sonnet-4-6");
    expect(config.agents[2].model).toBe("claude-haiku-3-5");
  });

  it("creates standard directories on migration", async () => {
    const configPath = await writeMockFiles();
    await migrateFromOpenClaw({ configPaths: [configPath] });

    for (const dir of ["agents", "skills", "plugins", "logs"]) {
      expect(existsSync(join(ccgHome, dir))).toBe(true);
    }
  });

  it("handles bindings with missing peer (Slack-style)", async () => {
    const ocConfig = {
      agents: {
        list: [
          { id: "bot1", identity: { name: "Bot1" } },
        ],
      },
      bindings: [
        {
          agentId: "bot1",
          match: {
            channel: "slack",
            accountId: "default",
            // no peer — Slack bindings don't have one
          },
        },
      ],
    };

    const configPath = await writeMockFiles(ocConfig);
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    const binding = config.bindings.find((b: { gateway: string }) => b.gateway === "slack");
    expect(binding).toBeDefined();
    expect(binding.channel).toBe("*");
    expect(binding.agent).toBe("bot1");
  });
});

// ── Tests: synthesized agents ───────────────────────────────────────────────

describe("synthesized agents", () => {
  it("synthesizes a single agent when no agents.list exists", async () => {
    const ocConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          workspace: "/home/user/project",
          maxConcurrent: 2,
        },
      },
      channels: {
        slack: {
          botToken: "xoxb-synth-token",
          appToken: "xapp-synth-token",
        },
      },
    };

    const configPath = await writeNamedInstance("sentri", ocConfig);
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.agents).toHaveLength(1);

    const agent = config.agents[0];
    expect(agent.id).toBe("sentri");
    expect(agent.name).toBe("sentri");
    expect(agent.model).toBe("claude-sonnet-4-6");
    expect(agent.workspace).toBe("/home/user/project");
    expect(agent.maxConcurrentSessions).toBe(2);
  });

  it("synthesized agent uses fallback defaults when no agents.defaults", async () => {
    const ocConfig = {
      channels: {
        slack: {
          botToken: "xoxb-bare",
          appToken: "xapp-bare",
        },
      },
    };

    const configPath = await writeNamedInstance("bare", ocConfig);
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    const agent = config.agents[0];
    expect(agent.id).toBe("bare");
    expect(agent.model).toBe("claude-sonnet-4-6");
    expect(agent.maxConcurrentSessions).toBe(4);
  });
});

// ── Tests: Slack token extraction ───────────────────────────────────────────

describe("Slack token extraction", () => {
  it("extracts Pattern 1: multi-bot accounts", async () => {
    const ocConfig = {
      agents: {
        list: [
          { id: "default", identity: { name: "Default" } },
          { id: "vilma", identity: { name: "Vilma" } },
        ],
      },
      bindings: [
        {
          agentId: "default",
          match: { channel: "slack", accountId: "default" },
        },
        {
          agentId: "vilma",
          match: { channel: "slack", accountId: "vilma" },
        },
      ],
      channels: {
        slack: {
          accounts: {
            default: { botToken: "xoxb-default-123", appToken: "xapp-default-456" },
            vilma: { botToken: "xoxb-vilma-789", appToken: "xapp-vilma-012" },
          },
        },
      },
    };

    const configPath = await writeMockFiles(ocConfig);
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    // Should have slack-gateway plugin
    const slackPlugin = config.plugins.find((p: { name: string }) => p.name === "slack-gateway");
    expect(slackPlugin).toBeDefined();
    expect(slackPlugin.config.bots.default).toEqual({
      token: "$SLACK_DEFAULT_TOKEN",
      appToken: "$SLACK_DEFAULT_APP_TOKEN",
    });
    expect(slackPlugin.config.bots.vilma).toEqual({
      token: "$SLACK_VILMA_TOKEN",
      appToken: "$SLACK_VILMA_APP_TOKEN",
    });

    // Check .env
    const envContent = await readFile(join(ccgHome, ".env"), "utf-8");
    expect(envContent).toContain("export SLACK_DEFAULT_TOKEN=xoxb-default-123");
    expect(envContent).toContain("export SLACK_DEFAULT_APP_TOKEN=xapp-default-456");
    expect(envContent).toContain("export SLACK_VILMA_TOKEN=xoxb-vilma-789");
    expect(envContent).toContain("export SLACK_VILMA_APP_TOKEN=xapp-vilma-012");
  });

  it("extracts Pattern 2: top-level single bot", async () => {
    const ocConfig = {
      agents: {
        list: [
          { id: "sentri", identity: { name: "Sentri" } },
        ],
      },
      channels: {
        slack: {
          botToken: "xoxb-sentri-token",
          appToken: "xapp-sentri-token",
        },
      },
    };

    const configPath = await writeNamedInstance("sentri", ocConfig);
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    // Plugin should name the bot after the instance
    const slackPlugin = config.plugins.find((p: { name: string }) => p.name === "slack-gateway");
    expect(slackPlugin).toBeDefined();
    expect(slackPlugin.config.bots.sentri).toEqual({
      token: "$SLACK_SENTRI_TOKEN",
      appToken: "$SLACK_SENTRI_APP_TOKEN",
    });

    // Check .env
    const envContent = await readFile(join(ccgHome, ".env"), "utf-8");
    expect(envContent).toContain("export SLACK_SENTRI_TOKEN=xoxb-sentri-token");
    expect(envContent).toContain("export SLACK_SENTRI_APP_TOKEN=xapp-sentri-token");
  });

  it("generates both slack-gateway and discord-gateway plugins when both exist", async () => {
    const ocConfig = {
      agents: {
        list: [
          { id: "main", identity: { name: "Main" } },
        ],
      },
      bindings: [
        {
          agentId: "main",
          match: { channel: "discord", accountId: "ginger", peer: { kind: "channel", id: "ch1" } },
        },
        {
          agentId: "main",
          match: { channel: "slack", accountId: "default" },
        },
      ],
      channels: {
        discord: {
          accounts: {
            ginger: { token: "discord-token-123" },
          },
        },
        slack: {
          accounts: {
            default: { botToken: "xoxb-test", appToken: "xapp-test" },
          },
        },
      },
    };

    const configPath = await writeMockFiles(ocConfig);
    await migrateFromOpenClaw({ configPaths: [configPath] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.plugins).toHaveLength(2);

    const names = config.plugins.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(["discord-gateway", "slack-gateway"]);
  });
});

// ── Tests: multi-instance migration ─────────────────────────────────────────

describe("multi-instance migration", () => {
  it("merges two instances with no collisions", async () => {
    const instance1 = {
      agents: {
        list: [
          { id: "ginger", identity: { name: "Ginger" } },
        ],
      },
      channels: {
        discord: {
          accounts: { ginger: { token: "discord-ginger-token" } },
        },
      },
    };

    const instance2 = {
      agents: {
        list: [
          { id: "vilma", identity: { name: "Vilma" } },
        ],
      },
      channels: {
        slack: {
          botToken: "xoxb-vilma",
          appToken: "xapp-vilma",
        },
      },
    };

    const path1 = await writeNamedInstance("openclaw", instance1);
    const path2 = await writeNamedInstance("sentri", instance2);

    await migrateFromOpenClaw({ configPaths: [path1, path2] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    // Both agents present, no renames
    expect(config.agents).toHaveLength(2);
    expect(config.agents.find((a: { id: string }) => a.id === "ginger")).toBeDefined();
    expect(config.agents.find((a: { id: string }) => a.id === "vilma")).toBeDefined();

    // Both plugins
    expect(config.plugins).toHaveLength(2);
  });

  it("resolves agent ID collisions across instances", async () => {
    const instance1 = {
      agents: {
        list: [
          { id: "main", identity: { name: "Ginger" } },
          { id: "ginger", identity: { name: "Ginger Alt" } },
        ],
      },
    };

    const instance2 = {
      agents: {
        list: [
          { id: "main", identity: { name: "Sentri Main" } },
          { id: "vilma", identity: { name: "Vilma" } },
        ],
      },
    };

    const path1 = await writeNamedInstance("openclaw", instance1);
    const path2 = await writeNamedInstance("sentri", instance2);

    await migrateFromOpenClaw({ configPaths: [path1, path2] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.agents).toHaveLength(4);

    // "main" collides → renamed
    expect(config.agents.find((a: { id: string }) => a.id === "openclaw-main")).toBeDefined();
    expect(config.agents.find((a: { id: string }) => a.id === "sentri-main")).toBeDefined();

    // Unique IDs stay
    expect(config.agents.find((a: { id: string }) => a.id === "ginger")).toBeDefined();
    expect(config.agents.find((a: { id: string }) => a.id === "vilma")).toBeDefined();
  });

  it("bindings use post-collision-resolution agent IDs", async () => {
    const instance1 = {
      agents: {
        list: [{ id: "main", identity: { name: "Ginger" } }],
      },
      bindings: [
        {
          agentId: "main",
          match: { channel: "discord", accountId: "ginger", peer: { kind: "channel", id: "ch1" } },
        },
      ],
      channels: {
        discord: { accounts: { ginger: { token: "tok1" } } },
      },
    };

    const instance2 = {
      agents: {
        list: [{ id: "main", identity: { name: "Sentri" } }],
      },
      bindings: [
        {
          agentId: "main",
          match: { channel: "slack", accountId: "default" },
        },
      ],
      channels: {
        slack: {
          accounts: {
            default: { botToken: "xoxb-test", appToken: "xapp-test" },
          },
        },
      },
    };

    const path1 = await writeNamedInstance("openclaw", instance1);
    const path2 = await writeNamedInstance("sentri", instance2);

    await migrateFromOpenClaw({ configPaths: [path1, path2] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    const discordBinding = config.bindings.find((b: { gateway: string }) => b.gateway === "discord");
    expect(discordBinding.agent).toBe("openclaw-main");

    const slackBinding = config.bindings.find((b: { gateway: string; channel: string }) =>
      b.gateway === "slack" && b.channel === "*",
    );
    expect(slackBinding).toBeDefined();
    expect(slackBinding.agent).toBe("sentri-main");
  });

  it("merges .env from all instances", async () => {
    const instance1 = {
      agents: { list: [{ id: "ginger" }] },
      channels: {
        discord: { accounts: { ginger: { token: "discord-tok" } } },
      },
    };

    const instance2 = {
      agents: { list: [{ id: "vilma" }] },
      channels: {
        slack: {
          accounts: {
            vilma: { botToken: "xoxb-vilma", appToken: "xapp-vilma" },
          },
        },
      },
    };

    const path1 = await writeNamedInstance("openclaw", instance1);
    const path2 = await writeNamedInstance("sentri", instance2);

    await migrateFromOpenClaw({ configPaths: [path1, path2] });

    const envContent = await readFile(join(ccgHome, ".env"), "utf-8");
    expect(envContent).toContain("DISCORD_GINGER_TOKEN=discord-tok");
    expect(envContent).toContain("SLACK_VILMA_TOKEN=xoxb-vilma");
    expect(envContent).toContain("SLACK_VILMA_APP_TOKEN=xapp-vilma");
  });

  it("deduplicates bindings by gateway:channel:bot key", async () => {
    const instance1 = {
      agents: { list: [{ id: "bot1" }] },
      bindings: [
        {
          agentId: "bot1",
          match: { channel: "discord", accountId: "ginger", peer: { kind: "channel", id: "ch1" } },
        },
      ],
    };

    // instance2 has a binding with the same gateway:channel:bot
    const instance2 = {
      agents: { list: [{ id: "bot2" }] },
      bindings: [
        {
          agentId: "bot2",
          match: { channel: "discord", accountId: "ginger", peer: { kind: "channel", id: "ch1" } },
        },
      ],
    };

    const path1 = await writeNamedInstance("openclaw", instance1);
    const path2 = await writeNamedInstance("sentri", instance2);

    await migrateFromOpenClaw({ configPaths: [path1, path2] });

    const raw = await readFile(join(ccgHome, "config.json"), "utf-8");
    const config = JSON.parse(raw);

    // Only one binding for discord:ch1:ginger (first one wins)
    const discordBindings = config.bindings.filter(
      (b: { gateway: string; channel: string; bot: string }) =>
        b.gateway === "discord" && b.channel === "ch1" && b.bot === "ginger",
    );
    expect(discordBindings).toHaveLength(1);
  });

});

// ── Skill install/uninstall ──────────────────────────────────────────────────

describe("installCcgSkill", () => {
  it("copies SKILL.md to ~/.claude/skills/ccgateway-talk/", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    await installCcgSkill();

    const skillPath = join(fakeClaudeHome, "skills", "ccgateway-talk", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const content = await readFile(skillPath, "utf-8");
    expect(content).toContain("name: talk");
    expect(content).toContain("ccgateway");

    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("overwrites existing skill file on reinstall", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    // Install twice — should not throw
    await installCcgSkill();
    await installCcgSkill();

    const skillPath = join(fakeClaudeHome, "skills", "ccgateway-talk", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    delete process.env.CLAUDE_CONFIG_DIR;
  });
});

describe("uninstallCcgSkill", () => {
  it("removes the ccgateway-talk skill directory", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    // Install first
    await installCcgSkill();
    const skillDir = join(fakeClaudeHome, "skills", "ccgateway-talk");
    expect(existsSync(skillDir)).toBe(true);

    // Uninstall
    await uninstallCcgSkill();
    expect(existsSync(skillDir)).toBe(false);

    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("does not throw when skill directory does not exist", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    await expect(uninstallCcgSkill()).resolves.not.toThrow();

    delete process.env.CLAUDE_CONFIG_DIR;
  });
});
