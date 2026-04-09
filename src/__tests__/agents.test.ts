import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRegistry } from "../agents.js";
import type { AgentConfig, CcgConfig } from "../config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    emoji: "T",
    workspace: "/tmp/fake-workspace",
    model: "claude-sonnet-4-6",
    skills: [],
    allowedTools: ["Edit", "Read", "Write", "Bash", "Grep", "Glob"],
    maxConcurrentSessions: 4,
    ...overrides,
  };
}

function makeConfig(agents: AgentConfig[] = []): CcgConfig {
  return {
    agents,
    bindings: [],
    plugins: [],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("AgentRegistry", () => {
  describe("constructor", () => {
    it("loads agents from config", () => {
      const a1 = makeAgent({ id: "a1", name: "Agent One" });
      const a2 = makeAgent({ id: "a2", name: "Agent Two" });
      const registry = new AgentRegistry(makeConfig([a1, a2]));

      expect(registry.listAgents()).toHaveLength(2);
      expect(registry.getAgent("a1")).toEqual(a1);
      expect(registry.getAgent("a2")).toEqual(a2);
    });

    it("creates an empty registry from empty config", () => {
      const registry = new AgentRegistry(makeConfig());
      expect(registry.listAgents()).toHaveLength(0);
    });
  });

  describe("getAgent", () => {
    it("returns the correct agent", () => {
      const agent = makeAgent({ id: "my-agent", name: "My Agent" });
      const registry = new AgentRegistry(makeConfig([agent]));

      const result = registry.getAgent("my-agent");
      expect(result).toEqual(agent);
    });

    it("returns undefined for unknown id", () => {
      const registry = new AgentRegistry(makeConfig());
      expect(registry.getAgent("nonexistent")).toBeUndefined();
    });
  });

  describe("listAgents", () => {
    it("returns all agents", () => {
      const agents = [
        makeAgent({ id: "a1" }),
        makeAgent({ id: "a2" }),
        makeAgent({ id: "a3" }),
      ];
      const registry = new AgentRegistry(makeConfig(agents));

      const list = registry.listAgents();
      expect(list).toHaveLength(3);
      expect(list.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    });
  });

  describe("addAgent", () => {
    it("adds an agent to the registry", () => {
      const registry = new AgentRegistry(makeConfig());
      const agent = makeAgent({ id: "new-agent" });

      registry.addAgent(agent);

      expect(registry.getAgent("new-agent")).toEqual(agent);
      expect(registry.listAgents()).toHaveLength(1);
    });

    it("rejects duplicate id", () => {
      const agent = makeAgent({ id: "dup" });
      const registry = new AgentRegistry(makeConfig([agent]));

      expect(() => registry.addAgent(makeAgent({ id: "dup" }))).toThrow(
        'Agent with id "dup" already exists',
      );
    });
  });

  describe("removeAgent", () => {
    it("removes an agent and returns true", () => {
      const agent = makeAgent({ id: "removable" });
      const registry = new AgentRegistry(makeConfig([agent]));

      const result = registry.removeAgent("removable");
      expect(result).toBe(true);
      expect(registry.getAgent("removable")).toBeUndefined();
      expect(registry.listAgents()).toHaveLength(0);
    });

    it("returns false for unknown id", () => {
      const registry = new AgentRegistry(makeConfig());

      const result = registry.removeAgent("ghost");
      expect(result).toBe(false);
    });
  });

  describe("validateWorkspace", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "ccg-agent-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("validates a workspace with CLAUDE.md", async () => {
      await writeFile(join(tempDir, "CLAUDE.md"), "# Agent workspace\n");

      const agent = makeAgent({ id: "valid-agent", workspace: tempDir });
      const registry = new AgentRegistry(makeConfig([agent]));

      const result = registry.validateWorkspace("valid-agent");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("fails when workspace directory does not exist", () => {
      const agent = makeAgent({
        id: "missing-ws",
        workspace: "/tmp/nonexistent-workspace-xyz-12345",
      });
      const registry = new AgentRegistry(makeConfig([agent]));

      const result = registry.validateWorkspace("missing-ws");
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/does not exist/);
    });

    it("fails when workspace is missing CLAUDE.md", async () => {
      // tempDir exists but has no CLAUDE.md
      const agent = makeAgent({
        id: "no-claude-md",
        workspace: tempDir,
      });
      const registry = new AgentRegistry(makeConfig([agent]));

      const result = registry.validateWorkspace("no-claude-md");
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/missing CLAUDE\.md/);
    });

    it("fails for unknown agent id", () => {
      const registry = new AgentRegistry(makeConfig());

      const result = registry.validateWorkspace("unknown");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/not found in registry/);
    });
  });
});
