import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, type SessionMessage } from "../sessions.js";

// ── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let mgr: SessionManager;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccg-sessions-test-"));
  mgr = new SessionManager(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMessage(
  role: SessionMessage["role"],
  content: string,
  ts: number = Date.now(),
): SessionMessage {
  return { role, content, ts };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getOrCreateSession", () => {
  it("returns correct key format", () => {
    const key = mgr.getOrCreateSession("salt", "discord", "1465736400014938230");
    expect(key).toBe("salt:discord:1465736400014938230");
  });
});

describe("appendMessage", () => {
  it("creates file and writes JSONL", async () => {
    const key = "salt:discord:12345";
    const msg = makeMessage("user", "Hello there");

    await mgr.appendMessage("salt", key, msg);

    const filePath = mgr.getSessionPath("salt", key);
    expect(existsSync(filePath)).toBe(true);

    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("Hello there");
  });

  it("appends multiple messages as separate lines", async () => {
    const key = "salt:discord:12345";

    await mgr.appendMessage("salt", key, makeMessage("user", "Hello"));
    await mgr.appendMessage("salt", key, makeMessage("assistant", "Hi!"));
    await mgr.appendMessage("salt", key, makeMessage("user", "How are you?"));

    const filePath = mgr.getSessionPath("salt", key);
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
  });
});

describe("readHistory", () => {
  it("reads messages back", async () => {
    const key = "salt:discord:12345";
    const msg1 = makeMessage("user", "Hello", 1000);
    const msg2 = makeMessage("assistant", "Hi there", 2000);

    await mgr.appendMessage("salt", key, msg1);
    await mgr.appendMessage("salt", key, msg2);

    const history = await mgr.readHistory("salt", key);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(msg1);
    expect(history[1]).toEqual(msg2);
  });

  it("returns empty array for non-existent session", async () => {
    const history = await mgr.readHistory("salt", "salt:discord:nonexistent");
    expect(history).toEqual([]);
  });
});

describe("getWindowedHistory", () => {
  it("returns all messages when within budget", async () => {
    const key = "salt:discord:12345";

    await mgr.appendMessage("salt", key, makeMessage("user", "short", 1000));
    await mgr.appendMessage("salt", key, makeMessage("assistant", "reply", 2000));

    const history = await mgr.getWindowedHistory("salt", key, 200000);
    expect(history).toHaveLength(2);
  });

  it("drops oldest messages when over budget", async () => {
    const key = "salt:discord:12345";

    // Each message has 400 chars → ~100 tokens each
    const longContent = "x".repeat(400);
    await mgr.appendMessage("salt", key, makeMessage("user", longContent, 1000));
    await mgr.appendMessage("salt", key, makeMessage("assistant", longContent, 2000));
    await mgr.appendMessage("salt", key, makeMessage("user", longContent, 3000));

    // Budget of 200 tokens — can fit 2 messages (100 tokens each), not 3
    const history = await mgr.getWindowedHistory("salt", key, 200);
    expect(history).toHaveLength(2);
    // Should keep the newest two messages
    expect(history[0].ts).toBe(2000);
    expect(history[1].ts).toBe(3000);
  });

  it("always keeps last message even if over budget", async () => {
    const key = "salt:discord:12345";

    // Single message that is 800 chars → 200 tokens
    const hugeContent = "x".repeat(800);
    await mgr.appendMessage("salt", key, makeMessage("user", hugeContent, 1000));

    // Budget of 10 tokens — well under single message size
    const history = await mgr.getWindowedHistory("salt", key, 10);
    expect(history).toHaveLength(1);
    expect(history[0].ts).toBe(1000);
  });

  it("returns empty array for non-existent session", async () => {
    const history = await mgr.getWindowedHistory("salt", "salt:discord:nope");
    expect(history).toEqual([]);
  });
});

describe("resetSession", () => {
  it("archives file with timestamp", async () => {
    const key = "salt:discord:12345";
    await mgr.appendMessage("salt", key, makeMessage("user", "Hello", 1000));

    const filePath = mgr.getSessionPath("salt", key);
    expect(existsSync(filePath)).toBe(true);

    await mgr.resetSession("salt", key);

    // Original file should no longer exist
    expect(existsSync(filePath)).toBe(false);

    // An archived file should exist in the sessions directory
    const sessionsDir = join(tempDir, "agents", "salt", "sessions");
    const files = await readdir(sessionsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^salt-discord-12345\.\d+\.jsonl$/);
  });

  it("does nothing for non-existent session", async () => {
    // Should not throw
    await mgr.resetSession("salt", "salt:discord:nonexistent");
  });
});

describe("listSessions", () => {
  it("returns all sessions", async () => {
    await mgr.appendMessage(
      "salt",
      "salt:discord:111",
      makeMessage("user", "Hello from salt", 1000),
    );
    await mgr.appendMessage(
      "pepper",
      "pepper:slack:222",
      makeMessage("user", "Hello from pepper", 2000),
    );

    const sessions = await mgr.listSessions();
    expect(sessions).toHaveLength(2);

    const keys = sessions.map((s) => s.sessionKey).sort();
    expect(keys).toEqual(["pepper:slack:222", "salt:discord:111"]);
  });

  it("filters by agent", async () => {
    await mgr.appendMessage(
      "salt",
      "salt:discord:111",
      makeMessage("user", "Hello", 1000),
    );
    await mgr.appendMessage(
      "pepper",
      "pepper:slack:222",
      makeMessage("user", "Hello", 2000),
    );

    const sessions = await mgr.listSessions("salt");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentId).toBe("salt");
    expect(sessions[0].sessionKey).toBe("salt:discord:111");
    expect(sessions[0].messageCount).toBe(1);
    expect(sessions[0].lastActivity).toBe(1000);
  });

  it("returns empty array when no agents directory exists", async () => {
    const sessions = await mgr.listSessions();
    expect(sessions).toEqual([]);
  });

  it("does not include archived sessions", async () => {
    const key = "salt:discord:111";
    await mgr.appendMessage("salt", key, makeMessage("user", "Hello", 1000));
    await mgr.resetSession("salt", key);

    const sessions = await mgr.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it("returns correct SessionInfo fields", async () => {
    const key = "salt:discord:111";
    await mgr.appendMessage("salt", key, makeMessage("user", "First", 1000));
    await mgr.appendMessage("salt", key, makeMessage("assistant", "Second", 2000));

    const sessions = await mgr.listSessions("salt");
    expect(sessions).toHaveLength(1);

    const info = sessions[0];
    expect(info.agentId).toBe("salt");
    expect(info.sessionKey).toBe("salt:discord:111");
    expect(info.messageCount).toBe(2);
    expect(info.lastActivity).toBe(2000);
    expect(info.filePath).toBe(mgr.getSessionPath("salt", key));
  });
});
