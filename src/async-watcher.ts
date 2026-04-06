import { execSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AsyncTask {
  sessionName: string;
  taskDir: string;
  agentId: string;
  gateway: string;
  channel: string;
  botId: string;
  sessionKey: string;
  workspace: string;
  startedAt: number;
}

export interface WatcherCallbacks {
  sendToChannel: (channel: string, botId: string, content: string) => Promise<void>;
  appendToSession: (agentId: string, sessionKey: string, content: string, tokens: { in: number; out: number }) => Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;
const OUTPUT_TAIL_CHARS = 2000;
const SUMMARY_TIMEOUT_MS = 30_000;

// ── AsyncTaskWatcher ───────────────────────────────────────────────────────

export class AsyncTaskWatcher {
  private tasks: AsyncTask[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private callbacks: WatcherCallbacks;

  constructor(callbacks: WatcherCallbacks) {
    this.callbacks = callbacks;
  }

  /** Register a new async task to watch. */
  register(task: AsyncTask): void {
    this.tasks.push(task);
    logger.info(`async-watcher: tracking ${task.sessionName} (agent=${task.agentId})`);
  }

  /** List all in-flight tasks. */
  listTasks(): readonly AsyncTask[] {
    return this.tasks;
  }

  /** Start the polling loop. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.poll().catch((err) => {
        logger.error(`async-watcher: poll error: ${(err as Error).message}`);
      });
    }, POLL_INTERVAL_MS);
    logger.info("async-watcher: started");
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Whether the watcher is actively polling. */
  isRunning(): boolean {
    return this.interval !== null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /** Single poll cycle — check all tasks. */
  async poll(): Promise<void> {
    const completed: AsyncTask[] = [];

    for (const task of this.tasks) {
      if (!this.isSessionAlive(task.sessionName)) {
        completed.push(task);
      }
    }

    for (const task of completed) {
      await this.handleCompletion(task);
    }
  }

  /** Check if a tmux/screen session is still running. */
  private isSessionAlive(sessionName: string): boolean {
    try {
      execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: "pipe" });
      return true;
    } catch {
      // tmux failed — try screen
    }
    try {
      const output = execSync(`screen -ls`, { encoding: "utf-8", stdio: "pipe" });
      return output.includes(sessionName);
    } catch {
      return false;
    }
  }

  /** Handle a completed task: resolve result, post, clean up. */
  private async handleCompletion(task: AsyncTask): Promise<void> {
    logger.info(`async-watcher: ${task.sessionName} completed, resolving result`);

    let result: string;
    try {
      result = await this.resolveResult(task);
    } catch (err) {
      result = `Task completed but failed to retrieve result: ${(err as Error).message}`;
    }

    // Post result to channel
    try {
      await this.callbacks.sendToChannel(task.channel, task.botId, result);
    } catch (err) {
      logger.error(`async-watcher: failed to post result for ${task.sessionName}: ${(err as Error).message}`);
    }

    // Append to session history
    try {
      await this.callbacks.appendToSession(
        task.agentId,
        task.sessionKey,
        result,
        { in: 0, out: Math.ceil(result.length / 4) },
      );
    } catch (err) {
      logger.error(`async-watcher: failed to append session for ${task.sessionName}: ${(err as Error).message}`);
    }

    // Clean up task directory
    try {
      await rm(task.taskDir, { recursive: true, force: true });
    } catch {
      // non-fatal
    }

    // Remove from registry
    this.tasks = this.tasks.filter((t) => t.sessionName !== task.sessionName);
    logger.info(`async-watcher: ${task.sessionName} fully resolved and cleaned up`);
  }

  /**
   * Resolve the result text for a completed task.
   * Priority: RESULT.md > Sonnet summary > output.log tail
   */
  private async resolveResult(task: AsyncTask): Promise<string> {
    // 1. Try RESULT.md
    const resultPath = join(task.taskDir, "RESULT.md");
    if (existsSync(resultPath)) {
      const content = await readFile(resultPath, "utf-8");
      if (content.trim()) return content.trim();
    }

    // 2. Try Sonnet summary of git diff
    try {
      const summary = await this.runSummaryFallback(task.workspace);
      if (summary.trim()) return summary.trim();
    } catch {
      // fall through
    }

    // 3. Tail of output.log
    const logPath = join(task.taskDir, "output.log");
    if (existsSync(logPath)) {
      const log = await readFile(logPath, "utf-8");
      if (log.length > OUTPUT_TAIL_CHARS) {
        return `...\n${log.slice(-OUTPUT_TAIL_CHARS)}`;
      }
      if (log.trim()) return log.trim();
    }

    return "Task completed but produced no output.";
  }

  /** Quick Sonnet call to summarize what was done based on git diff. */
  private runSummaryFallback(workspace: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        "claude",
        [
          "--print",
          "--dangerously-skip-permissions",
          "--bare",
          "--model",
          "sonnet",
          "-p",
          "Summarize what was changed in this workspace based on `git diff HEAD~1` and `git log -1`. Be concise (under 500 words).",
        ],
        { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("summary timed out"));
      }, SUMMARY_TIMEOUT_MS);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) {
          resolve(stdout);
        } else {
          reject(new Error("summary failed"));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
