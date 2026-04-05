import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionManager } from "./sessions.js";
import type { SkillManager } from "./skills.js";
import type { AgentRegistry } from "./agents.js";

// ── Inbox types ────────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string;
  content: string;
  ts: number;
  read: boolean;
}

// ── Identity files loaded from workspace ──────────────────────────────────

const IDENTITY_FILES = [
  "CLAUDE.md",
  "SOUL.md",
  "IDENTITY.md",
  "AGENTS.md",
];

// ── ContextBuilder ─────────────────────────────────────────────────────────

export class ContextBuilder {
  constructor(
    private sessions: SessionManager,
    private skills: SkillManager,
    private ccgHome: string,
    private agents?: AgentRegistry,
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

    // 0. Agent identity (CLAUDE.md, SOUL.md, IDENTITY.md, AGENTS.md from workspace)
    const identitySection = await this.buildIdentitySection(agentId);
    if (identitySection) {
      parts.push(identitySection);
    }

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

  /**
   * Resolve the workspace path for an agent.
   * Returns undefined if no AgentRegistry is available or agent not found.
   */
  private getWorkspace(agentId: string): string | undefined {
    if (!this.agents) return undefined;
    const agent = this.agents.getAgent(agentId);
    return agent?.workspace;
  }

  /**
   * Read identity files from the agent's workspace.
   * Loads CLAUDE.md, SOUL.md, IDENTITY.md, AGENTS.md (whichever exist).
   */
  private async buildIdentitySection(agentId: string): Promise<string | null> {
    const workspace = this.getWorkspace(agentId);
    if (!workspace) return null;

    const parts: string[] = [];

    for (const filename of IDENTITY_FILES) {
      const filePath = join(workspace, filename);
      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath, "utf-8");
          parts.push(`=== ${filename} ===\n${content.trim()}`);
        } catch {
          // Skip unreadable files
        }
      }
    }

    if (parts.length === 0) return null;

    return `--- Agent Identity ---\n${parts.join("\n\n")}`;
  }

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
   * Read a daily log file. Checks the agent's workspace memory/ dir first,
   * then falls back to $CCG_HOME/agents/{agentId}/memory/.
   */
  private async readDailyLog(
    agentId: string,
    dateStr: string,
  ): Promise<string | null> {
    const filename = `${dateStr}.md`;

    // 1. Try workspace memory/ dir
    const workspace = this.getWorkspace(agentId);
    if (workspace) {
      const wsPath = join(workspace, "memory", filename);
      if (existsSync(wsPath)) {
        return readFile(wsPath, "utf-8");
      }
    }

    // 2. Fallback to $CCG_HOME/agents/{agentId}/memory/
    const ccgPath = join(this.ccgHome, "agents", agentId, "memory", filename);
    if (existsSync(ccgPath)) {
      return readFile(ccgPath, "utf-8");
    }

    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
