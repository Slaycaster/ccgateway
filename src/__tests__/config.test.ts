import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  saveConfig,
  ensureDirectories,
  getCcgHome,
  type CcgConfig,
} from "../config.js";

// ── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
const originalEnv = process.env.CCG_HOME;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccg-test-"));
  process.env.CCG_HOME = tempDir;
});

afterEach(async () => {
  process.env.CCG_HOME = originalEnv;
  await rm(tempDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getCcgHome", () => {
  it("uses CCG_HOME env var when set", () => {
    process.env.CCG_HOME = "/custom/path";
    expect(getCcgHome()).toBe("/custom/path");
    process.env.CCG_HOME = tempDir; // restore for cleanup
  });

  it("defaults to ~/.ccgateway when CCG_HOME is unset", () => {
    delete process.env.CCG_HOME;
    const home = getCcgHome();
    expect(home).toMatch(/\.ccgateway$/);
  });
});

describe("loadConfig", () => {
  it("returns default config when no file exists", async () => {
    const config = await loadConfig();
    expect(config).toEqual({
      agents: [],
      bindings: [],
      plugins: [],
    });
  });

  it("loads config from file", async () => {
    const testConfig: CcgConfig = {
      agents: [
        {
          id: "test-agent",
          name: "Test Agent",
          emoji: "🤖",
          workspace: "/tmp/test",
          model: "claude-sonnet-4-20250514",
          skills: ["code-review"],
          allowedTools: ["Bash", "Read"],
          maxConcurrentSessions: 3,
        },
      ],
      bindings: [
        {
          agent: "test-agent",
          gateway: "discord",
          channel: "#general",
          bot: "test-bot",
        },
      ],
      plugins: [
        {
          name: "memory",
          enabled: true,
          config: { backend: "sqlite" },
        },
      ],
    };

    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify(testConfig),
      "utf-8",
    );

    const loaded = await loadConfig();
    expect(loaded).toEqual(testConfig);
  });

  it("fills in missing arrays with defaults", async () => {
    // Config file with only agents — other fields should get defaults
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({ agents: [] }),
      "utf-8",
    );

    const loaded = await loadConfig();
    expect(loaded.bindings).toEqual([]);
    expect(loaded.plugins).toEqual([]);
  });
});

describe("saveConfig", () => {
  it("writes config to file", async () => {
    const config: CcgConfig = {
      agents: [],
      bindings: [],
      plugins: [
        { name: "test-plugin", enabled: false, config: {} },
      ],
    };

    await saveConfig(config);

    const raw = await readFile(join(tempDir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.plugins).toEqual(config.plugins);
  });

  it("creates CCG_HOME directory if it does not exist", async () => {
    const nested = join(tempDir, "nested", "ccg");
    process.env.CCG_HOME = nested;

    await saveConfig({
      agents: [],
      bindings: [],
      plugins: [],
    });

    expect(existsSync(join(nested, "config.json"))).toBe(true);
  });
});

describe("ensureDirectories", () => {
  it("creates agents, skills, plugins, logs directories", async () => {
    await ensureDirectories();

    for (const dir of ["agents", "skills", "plugins", "logs"]) {
      expect(existsSync(join(tempDir, dir))).toBe(true);
    }
  });

  it("is idempotent — does not error on existing dirs", async () => {
    await mkdir(join(tempDir, "agents"), { recursive: true });
    // Should not throw
    await ensureDirectories();
    expect(existsSync(join(tempDir, "agents"))).toBe(true);
  });
});
