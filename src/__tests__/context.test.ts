import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../sessions.js";
import { SkillManager } from "../skills.js";
import { ContextBuilder } from "../context.js";

// ── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let sessions: SessionManager;
let skills: SkillManager;
let builder: ContextBuilder;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccg-context-test-"));
  await mkdir(join(tempDir, "skills"), { recursive: true });
  await mkdir(join(tempDir, "agents", "salt", "sessions"), { recursive: true });

  sessions = new SessionManager(tempDir);
  skills = new SkillManager(tempDir);
  builder = new ContextBuilder(sessions, skills, tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSkillContent(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

// ── Conversation history section ───────────────────────────────────────────

describe("build — conversation history", () => {
  it("assembles conversation history section from session messages", async () => {
    const key = "salt:discord:12345";
    await sessions.appendMessage("salt", key, {
      role: "user",
      content: "Fix the export bug",
      ts: 1000,
      sourceUser: "Den",
    });
    await sessions.appendMessage("salt", key, {
      role: "assistant",
      content: "I'll look into the export handler...",
      ts: 2000,
    });
    await sessions.appendMessage("salt", key, {
      role: "user",
      content: "What did you find?",
      ts: 3000,
      sourceUser: "Den",
    });

    const context = await builder.build("salt", key);

    expect(context).toContain("--- Conversation History ---");
    expect(context).toContain("[user] Den: Fix the export bug");
    expect(context).toContain("[assistant]: I'll look into the export handler...");
    expect(context).toContain("[user] Den: What did you find?");
  });

  it("handles empty session history", async () => {
    const key = "salt:discord:empty";
    const context = await builder.build("salt", key);

    expect(context).toContain("--- Conversation History ---");
    expect(context).toContain("(empty)");
  });

  it("uses 'User' as default name when sourceUser is absent", async () => {
    const key = "salt:discord:12345";
    await sessions.appendMessage("salt", key, {
      role: "user",
      content: "Hello",
      ts: 1000,
    });

    const context = await builder.build("salt", key);

    expect(context).toContain("[user] User: Hello");
  });
});

// ── History format ─────────────────────────────────────────────────────────

describe("build — history format", () => {
  it("formats user messages as [user] Name: content", async () => {
    const key = "salt:discord:12345";
    await sessions.appendMessage("salt", key, {
      role: "user",
      content: "Deploy to staging",
      ts: 1000,
      sourceUser: "Alice",
    });

    const context = await builder.build("salt", key);
    expect(context).toContain("[user] Alice: Deploy to staging");
  });

  it("formats assistant messages as [assistant]: content", async () => {
    const key = "salt:discord:12345";
    await sessions.appendMessage("salt", key, {
      role: "assistant",
      content: "Deploying now...",
      ts: 1000,
    });

    const context = await builder.build("salt", key);
    expect(context).toContain("[assistant]: Deploying now...");
  });
});

// ── Skill index section ────────────────────────────────────────────────────

describe("build — skill index", () => {
  it("includes skill index in context", async () => {
    await writeFile(
      join(tempDir, "skills", "create-pr.md"),
      makeSkillContent("create-pr", "Create a pull request with conventional format"),
    );
    await writeFile(
      join(tempDir, "skills", "run-tests.md"),
      makeSkillContent("run-tests", "Run test suite and report results"),
    );

    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).toContain("--- Available Skills ---");
    expect(context).toContain(
      "- create-pr: Create a pull request with conventional format",
    );
    expect(context).toContain(
      "- run-tests: Run test suite and report results",
    );
  });

  it("shows (none) when no skills exist", async () => {
    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).toContain("--- Available Skills ---");
    expect(context).toContain("(none)");
  });
});

// ── Inbox section ──────────────────────────────────────────────────────────

describe("build — inbox messages", () => {
  it("includes unread inbox messages and marks them read", async () => {
    const inboxDir = join(tempDir, "agents", "salt");
    const inboxPath = join(inboxDir, "inbox.jsonl");

    const messages = [
      { from: "pepper", content: "RCA done for NHD-10763", ts: 1000, read: false },
      { from: "gateway", content: "Deploy complete", ts: 2000, read: false },
    ];
    await writeFile(
      inboxPath,
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      "utf-8",
    );

    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    // Should include unread messages
    expect(context).toContain("--- Inbox (2 unread) ---");
    expect(context).toContain("[pepper → you] RCA done for NHD-10763");
    expect(context).toContain("[gateway → you] Deploy complete");

    // Should have marked them as read
    const raw = await readFile(inboxPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.read).toBe(true);
    }
  });

  it("excludes already-read messages from inbox section", async () => {
    const inboxPath = join(tempDir, "agents", "salt", "inbox.jsonl");

    const messages = [
      { from: "pepper", content: "Old message", ts: 1000, read: true },
      { from: "gateway", content: "New message", ts: 2000, read: false },
    ];
    await writeFile(
      inboxPath,
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      "utf-8",
    );

    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).toContain("--- Inbox (1 unread) ---");
    expect(context).toContain("[gateway → you] New message");
    expect(context).not.toContain("Old message");
  });

  it("omits inbox section when no inbox file exists", async () => {
    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).not.toContain("--- Inbox");
  });

  it("omits inbox section when all messages are already read", async () => {
    const inboxPath = join(tempDir, "agents", "salt", "inbox.jsonl");

    const messages = [
      { from: "pepper", content: "Old", ts: 1000, read: true },
    ];
    await writeFile(
      inboxPath,
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      "utf-8",
    );

    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).not.toContain("--- Inbox");
  });
});

// ── Memory section ─────────────────────────────────────────────────────────

describe("build — memory section", () => {
  it("includes memory hints with today's date", async () => {
    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).toContain("--- Memory ---");
    expect(context).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
    expect(context).toMatch(
      /Daily log: memory\/\d{4}-\d{2}-\d{2}\.md \(create if missing, append observations\)/,
    );
  });

  it("includes today's daily log contents when file exists", async () => {
    const today = new Date();
    const todayStr = formatDate(today);
    const memoryDir = join(tempDir, "agents", "salt", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, `${todayStr}.md`),
      "# Today's observations\n- Found a bug in exports",
      "utf-8",
    );

    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).toContain(`=== memory/${todayStr}.md ===`);
    expect(context).toContain("# Today's observations");
    expect(context).toContain("- Found a bug in exports");
  });

  it("includes yesterday's daily log contents when file exists", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);
    const memoryDir = join(tempDir, "agents", "salt", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, `${yesterdayStr}.md`),
      "# Yesterday's notes\n- Deployed v2.1",
      "utf-8",
    );

    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).toContain(`=== memory/${yesterdayStr}.md ===`);
    expect(context).toContain("# Yesterday's notes");
    expect(context).toContain("- Deployed v2.1");
  });

  it("handles missing daily logs gracefully", async () => {
    // No memory directory exists at all
    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    // Should still have memory section header
    expect(context).toContain("--- Memory ---");
    expect(context).toMatch(/Today's date:/);
    // Should not contain === markers since no log files exist
    expect(context).not.toContain("===");
  });

  it("includes both today and yesterday logs when both exist", async () => {
    const today = new Date();
    const todayStr = formatDate(today);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    const memoryDir = join(tempDir, "agents", "salt", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, `${todayStr}.md`),
      "Today's log",
      "utf-8",
    );
    await writeFile(
      join(memoryDir, `${yesterdayStr}.md`),
      "Yesterday's log",
      "utf-8",
    );

    const key = "salt:discord:12345";
    const context = await builder.build("salt", key);

    expect(context).toContain(`=== memory/${todayStr}.md ===`);
    expect(context).toContain("Today's log");
    expect(context).toContain(`=== memory/${yesterdayStr}.md ===`);
    expect(context).toContain("Yesterday's log");
  });
});

// ── Full assembly ──────────────────────────────────────────────────────────

describe("build — full assembly", () => {
  it("assembles all sections in correct order", async () => {
    // Add conversation history
    const key = "salt:discord:12345";
    await sessions.appendMessage("salt", key, {
      role: "user",
      content: "Test message",
      ts: 1000,
      sourceUser: "Den",
    });

    // Add a skill
    await writeFile(
      join(tempDir, "skills", "test-skill.md"),
      makeSkillContent("test-skill", "A test skill"),
    );

    // Add inbox message
    const inboxPath = join(tempDir, "agents", "salt", "inbox.jsonl");
    await writeFile(
      inboxPath,
      JSON.stringify({ from: "pepper", content: "Hello", ts: 1000, read: false }) + "\n",
      "utf-8",
    );

    const context = await builder.build("salt", key);

    // Verify order: history comes before skills, skills before inbox, inbox before memory
    const historyIdx = context.indexOf("--- Conversation History ---");
    const skillsIdx = context.indexOf("--- Available Skills ---");
    const inboxIdx = context.indexOf("--- Inbox");
    const memoryIdx = context.indexOf("--- Memory ---");

    expect(historyIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(inboxIdx);
    expect(inboxIdx).toBeLessThan(memoryIdx);
  });
});

// ── Helper ─────────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
