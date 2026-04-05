import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionManager } from "./sessions.js";
import type { SkillManager } from "./skills.js";

// ── Inbox types ────────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string;
  content: string;
  ts: number;
  read: boolean;
}

// ── ContextBuilder ─────────────────────────────────────────────────────────

export class ContextBuilder {
  constructor(
    private sessions: SessionManager,
    private skills: SkillManager,
    private ccgHome: string,
  ) {}

  /**
   * Build the complete context string for an agent turn.
   * Assembles in this order:
   * 1. Conversation history (windowed from session JSONL)
   * 2. Skill index
   * 3. Inbox messages (unread, for non-gateway agents)
   * 4. Memory hints (today's date, daily log path, recent daily log contents)
   */
  async build(agentId: string, sessionKey: string): Promise<string> {
    const parts: string[] = [];

    // 1. Conversation history
    parts.push(await this.buildHistorySection(agentId, sessionKey));

    // 2. Skill index
    parts.push(await this.skills.buildSkillIndex(agentId));

    // 3. Inbox messages
    const inboxSection = await this.buildInboxSection(agentId);
    if (inboxSection) {
      parts.push(inboxSection);
    }

    // 4. Memory section
    parts.push(await this.buildMemorySection(agentId));

    return parts.join("\n\n");
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async buildHistorySection(
    agentId: string,
    sessionKey: string,
  ): Promise<string> {
    const messages = await this.sessions.getWindowedHistory(
      agentId,
      sessionKey,
    );

    if (messages.length === 0) {
      return "--- Conversation History ---\n(empty)";
    }

    const lines = messages.map((msg) => {
      if (msg.role === "user") {
        const name = msg.sourceUser || "User";
        return `[user] ${name}: ${msg.content}`;
      }
      return `[assistant]: ${msg.content}`;
    });

    return `--- Conversation History ---\n${lines.join("\n")}`;
  }

  private async buildInboxSection(agentId: string): Promise<string | null> {
    const inboxPath = join(
      this.ccgHome,
      "agents",
      agentId,
      "inbox.jsonl",
    );

    if (!existsSync(inboxPath)) {
      return null;
    }

    const raw = await readFile(inboxPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      return null;
    }

    const allMessages: InboxMessage[] = lines.map(
      (line) => JSON.parse(line) as InboxMessage,
    );
    const unread = allMessages.filter((m) => !m.read);

    if (unread.length === 0) {
      return null;
    }

    // Build the section
    const header = `--- Inbox (${unread.length} unread) ---`;
    const msgLines = unread.map(
      (m) => `[${m.from} → you] ${m.content}`,
    );

    // Mark messages as read: rewrite the file with all messages marked read
    const updated = allMessages.map((m) => ({ ...m, read: true }));
    const updatedContent =
      updated.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(inboxPath, updatedContent, "utf-8");

    return `${header}\n${msgLines.join("\n")}`;
  }

  private async buildMemorySection(agentId: string): Promise<string> {
    const today = new Date();
    const todayStr = formatDate(today);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    const parts: string[] = [];
    parts.push("--- Memory ---");
    parts.push(`Today's date: ${todayStr}`);
    parts.push(
      `Daily log: memory/${todayStr}.md (create if missing, append observations)`,
    );

    // Read today's daily log
    const todayLog = await this.readDailyLog(agentId, todayStr);
    if (todayLog !== null) {
      parts.push("");
      parts.push(`=== memory/${todayStr}.md ===`);
      parts.push(todayLog);
    }

    // Read yesterday's daily log
    const yesterdayLog = await this.readDailyLog(agentId, yesterdayStr);
    if (yesterdayLog !== null) {
      parts.push("");
      parts.push(`=== memory/${yesterdayStr}.md ===`);
      parts.push(yesterdayLog);
    }

    return parts.join("\n");
  }

  /**
   * Read a daily log file from the agent's workspace memory directory.
   * The workspace path is resolved via the agents directory structure.
   * Returns null if the file doesn't exist.
   */
  private async readDailyLog(
    agentId: string,
    dateStr: string,
  ): Promise<string | null> {
    // Daily logs live in $CCG_HOME/agents/{agentId}/memory/YYYY-MM-DD.md
    const logPath = join(
      this.ccgHome,
      "agents",
      agentId,
      "memory",
      `${dateStr}.md`,
    );

    if (!existsSync(logPath)) {
      return null;
    }

    return readFile(logPath, "utf-8");
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
