import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";
import type { CCSpawner } from "./spawner.js";
import type { SessionManager } from "./sessions.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AsyncTask {
  sessionName: string;
  taskDir: string;
  agentId: string;
  gateway: string;
  channel: string;
  botId: string;
  startedAt: number;
}

type SendToChannelFn = (
  channelId: string,
  botId: string,
  content: string,
) => Promise<void>;

type GetSendToChannelFn = (gateway: string) => SendToChannelFn | null;

// ── AsyncTaskWatcher ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000; // 10 seconds

export class AsyncTaskWatcher {
  private tasks: AsyncTask[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private spawner: CCSpawner,
    private sessions: SessionManager,
    private getSendToChannel: GetSendToChannelFn,
  ) {}

  /**
   * Register a new async task for monitoring.
   */
  register(task: AsyncTask): void {
    this.tasks.push(task);
    logger.info(`async-watcher: registered task ${task.sessionName} (agent=${task.agentId})`);
  }

  /**
   * Start the polling loop.
   */
  start(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);

    logger.info("async-watcher: started");
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("async-watcher: stopped");
  }

  /**
   * Get the list of active tasks.
   */
  getActiveTasks(): AsyncTask[] {
    return [...this.tasks];
  }

  /**
   * Cancel any async task(s) registered for the given (agent, gateway, channel).
   * Kills the tmux/screen session and removes the task(s) from monitoring.
   * Returns the number of tasks cancelled.
   */
  async cancelForChannel(
    agentId: string,
    gateway: string,
    channel: string,
  ): Promise<number> {
    let cancelled = 0;
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const task = this.tasks[i];
      if (
        task.agentId === agentId &&
        task.gateway === gateway &&
        task.channel === channel
      ) {
        this.tasks.splice(i, 1);
        try {
          await this.spawner.killSession(task.sessionName);
        } catch (err) {
          logger.warn(
            `async-watcher: failed to kill session ${task.sessionName}: ${(err as Error).message}`,
          );
        }
        try {
          const { rm } = await import("node:fs/promises");
          await rm(task.taskDir, { recursive: true, force: true });
        } catch {
          // non-fatal
        }
        cancelled++;
        logger.info(
          `async-watcher: cancelled task ${task.sessionName} for ${agentId}@${gateway}:${channel}`,
        );
      }
    }
    return cancelled;
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.tasks.length === 0) return;

    // Check each task — iterate backwards so we can splice completed ones
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const task = this.tasks[i];
      try {
        const alive = await this.spawner.isSessionAlive(task.sessionName);
        if (!alive) {
          logger.info(`async-watcher: session ${task.sessionName} ended, resolving result`);
          this.tasks.splice(i, 1);
          await this.resolveAndPost(task);
        }
      } catch (err) {
        logger.error(`async-watcher: error checking ${task.sessionName}: ${(err as Error).message}`);
      }
    }
  }

  // ── Result resolution ────────────────────────────────────────────────────

  private async resolveAndPost(task: AsyncTask): Promise<void> {
    let result: string;

    try {
      result = await this.resolveResult(task);
    } catch (err) {
      result = `[async] Task ${task.sessionName} completed but failed to resolve result: ${(err as Error).message}`;
    }

    // Post result to channel
    try {
      const sendFn = this.getSendToChannel(task.gateway);
      if (sendFn) {
        await sendFn(task.channel, task.botId, result);
      } else {
        logger.warn(`async-watcher: no sendToChannel for gateway ${task.gateway}`);
      }
    } catch (err) {
      logger.error(`async-watcher: failed to post result for ${task.sessionName}: ${(err as Error).message}`);
    }

    // Append result to session history
    try {
      const sessionKey = this.sessions.getOrCreateSession(
        task.agentId,
        task.gateway,
        task.channel,
      );
      await this.sessions.appendMessage(task.agentId, sessionKey, {
        role: "assistant",
        content: result,
        ts: Date.now(),
        tokens: { in: 0, out: 0 },
      });
    } catch (err) {
      logger.error(`async-watcher: failed to save session for ${task.sessionName}: ${(err as Error).message}`);
    }

    // Clean up task directory
    try {
      await rm(task.taskDir, { recursive: true, force: true });
    } catch {
      // non-fatal
    }
  }

  /**
   * Resolve the result of a completed task, in priority order:
   * 1. RESULT.md (Claude's own summary)
   * 2. Last ~2000 chars of output.log
   * 3. Fallback message
   */
  private async resolveResult(task: AsyncTask): Promise<string> {
    // 1. Try RESULT.md
    const resultPath = join(task.taskDir, "RESULT.md");
    if (existsSync(resultPath)) {
      const content = await readFile(resultPath, "utf-8");
      if (content.trim()) {
        return content.trim();
      }
    }

    // 2. Tail of output.log
    const logPath = join(task.taskDir, "output.log");
    if (existsSync(logPath)) {
      const log = await readFile(logPath, "utf-8");
      if (log.trim()) {
        const tail = log.slice(-2000);
        const prefix = log.length > 2000 ? "...(truncated)\n" : "";
        return `[async] Task completed. Output:\n\n${prefix}${tail}`;
      }
    }

    // 3. Fallback
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    return `[async] Task ${task.sessionName} completed after ${elapsed}s. No output captured.`;
  }
}
