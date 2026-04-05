import { appendFile, readFile, rename, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  source?: string;        // "discord" | "slack" | "cli"
  sourceUser?: string;     // display name
  sourceMessageId?: string;
  tokens?: { in: number; out: number };
}

export interface SessionInfo {
  agentId: string;
  sessionKey: string;
  messageCount: number;
  lastActivity: number;    // timestamp of last message
  filePath: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert a session key (with colons) to a filesystem-safe filename stem.
 * e.g. "salt:discord:1465736400014938230" → "salt-discord-1465736400014938230"
 */
function keyToFilename(sessionKey: string): string {
  return sessionKey.replace(/:/g, "-") + ".jsonl";
}

/**
 * Convert a filesystem filename back to a session key.
 * e.g. "salt-discord-1465736400014938230.jsonl" → "salt:discord:1465736400014938230"
 * The key format is {agentId}:{source}:{sourceId}. We know the agentId from context,
 * so we can reconstruct by replacing the first two dashes with colons.
 */
function filenameToKey(filename: string): string {
  const stem = filename.replace(/\.jsonl$/, "");
  // Replace first dash with colon, then second dash with colon.
  // The sourceId portion may itself contain dashes, so only replace first two.
  const first = stem.indexOf("-");
  if (first === -1) return stem;
  const second = stem.indexOf("-", first + 1);
  if (second === -1) return stem;
  return (
    stem.slice(0, first) +
    ":" +
    stem.slice(first + 1, second) +
    ":" +
    stem.slice(second + 1)
  );
}

// ── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private ccgHome: string;

  constructor(ccgHome: string) {
    this.ccgHome = ccgHome;
  }

  /**
   * Get or create a session. Returns the session key.
   */
  getOrCreateSession(agentId: string, source: string, sourceId: string): string {
    return `${agentId}:${source}:${sourceId}`;
  }

  /**
   * Get the JSONL file path for a session.
   */
  getSessionPath(agentId: string, sessionKey: string): string {
    return join(
      this.ccgHome,
      "agents",
      agentId,
      "sessions",
      keyToFilename(sessionKey),
    );
  }

  /**
   * Append a message to the session JSONL.
   */
  async appendMessage(
    agentId: string,
    sessionKey: string,
    message: SessionMessage,
  ): Promise<void> {
    const filePath = this.getSessionPath(agentId, sessionKey);
    const dir = join(this.ccgHome, "agents", agentId, "sessions");

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const line = JSON.stringify(message) + "\n";
    await appendFile(filePath, line, "utf-8");
  }

  /**
   * Read all messages from a session.
   * Returns an empty array for non-existent sessions.
   */
  async readHistory(
    agentId: string,
    sessionKey: string,
  ): Promise<SessionMessage[]> {
    const filePath = this.getSessionPath(agentId, sessionKey);

    if (!existsSync(filePath)) {
      return [];
    }

    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as SessionMessage);
  }

  /**
   * Build windowed history that fits within token budget.
   * Estimates tokens as chars/4. Returns newest messages that fit.
   * tokenBudget defaults to 200000.
   */
  async getWindowedHistory(
    agentId: string,
    sessionKey: string,
    tokenBudget: number = 200000,
  ): Promise<SessionMessage[]> {
    const messages = await this.readHistory(agentId, sessionKey);

    if (messages.length === 0) {
      return [];
    }

    // Always keep at least the most recent message
    const result: SessionMessage[] = [];
    let totalTokens = 0;

    // Walk backwards from newest to oldest
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = Math.ceil(messages[i].content.length / 4);

      if (result.length === 0) {
        // Always include the most recent message
        result.unshift(messages[i]);
        totalTokens += msgTokens;
        continue;
      }

      if (totalTokens + msgTokens <= tokenBudget) {
        result.unshift(messages[i]);
        totalTokens += msgTokens;
      } else {
        break;
      }
    }

    return result;
  }

  /**
   * Reset session: archive current JSONL (rename with timestamp suffix).
   */
  async resetSession(agentId: string, sessionKey: string): Promise<void> {
    const filePath = this.getSessionPath(agentId, sessionKey);

    if (!existsSync(filePath)) {
      return;
    }

    const timestamp = Date.now();
    const archivePath = filePath.replace(/\.jsonl$/, `.${timestamp}.jsonl`);
    await rename(filePath, archivePath);
  }

  /**
   * List all sessions, optionally filtered by agent.
   */
  async listSessions(agentId?: string): Promise<SessionInfo[]> {
    const agentsDir = join(this.ccgHome, "agents");
    const results: SessionInfo[] = [];

    if (!existsSync(agentsDir)) {
      return results;
    }

    const agentDirs = agentId ? [agentId] : await readdir(agentsDir);

    for (const agent of agentDirs) {
      const sessionsDir = join(agentsDir, agent, "sessions");

      if (!existsSync(sessionsDir)) {
        continue;
      }

      const files = await readdir(sessionsDir);

      for (const file of files) {
        // Only match active session files (not archived ones with timestamp suffix)
        if (!file.endsWith(".jsonl") || /\.\d+\.jsonl$/.test(file)) {
          continue;
        }

        const filePath = join(sessionsDir, file);
        const sessionKey = filenameToKey(file);
        const messages = await this.readHistory(agent, sessionKey);

        const lastActivity =
          messages.length > 0
            ? messages[messages.length - 1].ts
            : (await stat(filePath)).mtimeMs;

        results.push({
          agentId: agent,
          sessionKey,
          messageCount: messages.length,
          lastActivity,
          filePath,
        });
      }
    }

    return results;
  }
}
