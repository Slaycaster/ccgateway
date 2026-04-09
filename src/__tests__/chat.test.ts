import { describe, it, expect } from "vitest";
import { buildChatSessionKey, startChat } from "../chat.js";
import { AgentRegistry } from "../agents.js";
import { SessionManager } from "../sessions.js";
import { ContextBuilder } from "../context.js";
import { SkillManager } from "../skills.js";
import { CCSpawner } from "../spawner.js";
import type { CcgConfig } from "../config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(agents: CcgConfig["agents"] = []): CcgConfig {
  return { agents, bindings: [], plugins: [] };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("buildChatSessionKey", () => {
  it("returns {agentId}:cli:manual format", () => {
    expect(buildChatSessionKey("ginger")).toBe("ginger:cli:manual");
  });

  it("works with different agent ids", () => {
    expect(buildChatSessionKey("salt")).toBe("salt:cli:manual");
    expect(buildChatSessionKey("pepper")).toBe("pepper:cli:manual");
  });
});

describe("startChat — validation", () => {
  it("throws for unknown agent", async () => {
    const config = makeConfig([]);
    const registry = new AgentRegistry(config);
    const sessions = new SessionManager("/tmp/ccg-test");
    const skills = new SkillManager("/tmp/ccg-test");
    const context = new ContextBuilder(sessions, skills, "/tmp/ccg-test");
    const spawner = new CCSpawner();

    await expect(
      startChat("nonexistent", registry, sessions, context, spawner),
    ).rejects.toThrow('Agent "nonexistent" not found');
  });
});
