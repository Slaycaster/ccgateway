import { spawn, execFile, type ChildProcess } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SpawnResult {
  response: string;
  stderr: string;
  exitCode: number;
  tokensEstimate: { in: number; out: number };
}

export interface ImageInput {
  base64: string;
  mediaType: string;
}

export interface SpawnOptions {
  workspace: string;
  message: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  timeoutMs?: number;
  /** When provided, switches to --input-format stream-json so images are
   *  sent as content blocks directly (no Read-tool round-trip). */
  images?: ImageInput[];
  /** Optional key used to register the spawn for external cancellation via `cancel(key)`. */
  spawnKey?: string;
}

export interface AsyncSpawnOptions {
  workspace: string;
  message: string;
  systemPrompt: string;
  model: string;
  agentId: string;
  ccgHome: string;
}

export interface AsyncSpawnResult {
  sessionName: string;
  taskDir: string;
}

export type TriageResult = "sync" | "async";

/** Callback fired during streaming with the accumulated text so far. */
export type StreamCallback = (accumulated: string) => void;

// ── CCSpawner ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const IMAGE_TIMEOUT_MS = 600_000; // 10 minutes — vision calls on Opus are slower

/** Inactivity timeout: kill if no stdout data for this long. */
const INACTIVITY_TIMEOUT_MS = 900_000; // 15 minutes of silence

/** Absolute safety cap so processes can't run forever. */
const MAX_ABSOLUTE_TIMEOUT_MS = 1_800_000; // 30 minutes

/**
 * Build a clean environment for spawned `claude` child processes.
 * Strips inherited Claude Code env vars (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT,
 * CLAUDE_CODE_EXECPATH, CLAUDE_CODE_HIDE_ACCOUNT_INFO) so the child process
 * doesn't think it's a nested Claude Code session, which can cause different
 * rate-limit handling or feature restrictions.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Strip Claude Code nesting indicators
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EXECPATH;
  delete env.CLAUDE_CODE_HIDE_ACCOUNT_INFO;
  // Strip npm/node env vars inherited from `npx tsx` that may confuse
  // the child `claude` process into thinking it's part of an npm script
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }
  delete env.INIT_CWD;
  delete env.COLOR;
  delete env.NODE;
  return env;
}

export class CCSpawner {
  private _muxBinary: string | null | undefined = undefined; // undefined = not detected yet

  /** Active sync spawns keyed by `spawnKey` for external cancellation. */
  private activeSpawns = new Map<string, ChildProcess>();

  /**
   * Cancel an in-flight sync spawn by its registered key.
   * Sends SIGTERM, then SIGKILL after 2s if still alive.
   * Returns true if a spawn was found and killed.
   */
  cancel(key: string): boolean {
    const child = this.activeSpawns.get(key);
    if (!child) return false;

    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 2000);
    } catch {
      // ignore
    }
    this.activeSpawns.delete(key);
    return true;
  }

  /** Check if a spawn key currently has an active process. */
  isActive(key: string): boolean {
    return this.activeSpawns.has(key);
  }

  private registerSpawn(key: string | undefined, child: ChildProcess): void {
    if (!key) return;
    this.activeSpawns.set(key, child);
  }

  private unregisterSpawn(key: string | undefined, child: ChildProcess): void {
    if (!key) return;
    if (this.activeSpawns.get(key) === child) {
      this.activeSpawns.delete(key);
    }
  }

  // ── Triage ───────────────────────────────────────────────────────────────

  /**
   * Quick Sonnet call to classify a message as "sync" or "async".
   * Defaults to "sync" on any failure (timeout, parse error, etc.).
   */
  async triage(message: string): Promise<TriageResult> {
    const triagePrompt = [
      "Classify this user message as either sync or async.",
      "Reply with ONLY the word 'sync' or 'async', nothing else.",
      "",
      "sync = quick question, greeting, short answer, status check, clarification",
      "async = intensive coding task, refactor, build feature, multi-file edit, debugging, long-running work",
    ].join("\n");

    try {
      const result = await this.spawnText({
        workspace: "/tmp",
        message,
        systemPrompt: triagePrompt,
        model: "claude-haiku-4-5-20251001",
        allowedTools: [],
        timeoutMs: 15_000,
      });

      const answer = result.response.trim().toLowerCase();
      if (answer === "async") return "async";
      return "sync";
    } catch {
      return "sync";
    }
  }

  // ── Async spawn (tmux interactive mode) ──────────────────────────────────

  /**
   * Launch Claude Code in interactive mode inside a detached tmux session.
   *
   * - No `--print` flag — runs the full interactive REPL
   * - `--dangerously-skip-permissions` so it won't block on tool approvals
   * - System prompt injected via `--append-system-prompt-file`
   * - User's message sent via `tmux send-keys` after a short init delay
   * - Returns immediately with the session name and task directory
   */
  async spawnAsync(options: AsyncSpawnOptions): Promise<AsyncSpawnResult> {
    const mux = await this.detectMux();
    if (!mux) {
      throw new Error("Neither tmux nor screen is available. Install tmux to use async spawn.");
    }

    const { workspace, message, systemPrompt, model, agentId, ccgHome } = options;

    // Session naming: ccg-<agentId>-<shortId>
    const shortId = randomBytes(2).toString("hex");
    const sessionName = `ccg-${agentId}-${shortId}`;

    // Task directory
    const taskDir = join(ccgHome, "async-tasks", sessionName);
    await mkdir(taskDir, { recursive: true });

    // Write system prompt as INSTRUCTIONS.md
    await writeFile(join(taskDir, "INSTRUCTIONS.md"), systemPrompt, "utf-8");

    // Write the user's message to PROMPT.txt for send-keys
    const promptFile = join(taskDir, "PROMPT.txt");
    await writeFile(promptFile, message, "utf-8");

    const outputLog = join(taskDir, "output.log");
    const instructionsFile = join(taskDir, "INSTRUCTIONS.md");

    if (mux === "tmux") {
      // Launch tmux session with claude in interactive mode (no pipe — preserves TTY)
      const tmuxCmd = [
        `claude --dangerously-skip-permissions`,
        `--append-system-prompt-file ${instructionsFile}`,
        `--model ${model}`,
      ].join(" ");

      await execAsync("tmux", [
        "new-session", "-d",
        "-s", sessionName,
        "-c", workspace,
        tmuxCmd,
      ]);

      // Pipe output to log file while preserving TTY
      await execAsync("tmux", [
        "pipe-pane", "-t", sessionName,
        `cat >> ${outputLog}`,
      ]);

      // Wait for claude to initialize, then send the prompt + Enter
      await sleep(3000);

      // Use tmux load-buffer + paste-buffer for reliable long message delivery
      await execAsync("tmux", ["load-buffer", "-b", "ccg-prompt", promptFile]);
      await execAsync("tmux", ["paste-buffer", "-b", "ccg-prompt", "-d", "-t", sessionName]);
      await execAsync("tmux", ["send-keys", "-t", sessionName, "Enter"]);
    } else {
      // screen fallback (no pipe — preserves TTY)
      const screenCmd = [
        `cd ${workspace} &&`,
        `claude --dangerously-skip-permissions`,
        `--append-system-prompt-file ${instructionsFile}`,
        `--model ${model}`,
      ].join(" ");

      await execAsync("screen", [
        "-dmS", sessionName,
        "-L", "-Logfile", outputLog,
        "bash", "-c", screenCmd,
      ]);

      // Wait for claude to initialize, then stuff the prompt
      await sleep(3000);

      // screen uses -X stuff to send text
      await execAsync("screen", [
        "-S", sessionName,
        "-X", "stuff",
        message + "\n",
      ]);
    }

    return { sessionName, taskDir };
  }

  /**
   * Detect available terminal multiplexer. Cached after first call.
   * Returns "tmux", "screen", or null.
   */
  async detectMux(): Promise<string | null> {
    if (this._muxBinary !== undefined) return this._muxBinary;

    try {
      await execAsync("which", ["tmux"]);
      this._muxBinary = "tmux";
      return "tmux";
    } catch {
      // tmux not found, try screen
    }

    try {
      await execAsync("which", ["screen"]);
      this._muxBinary = "screen";
      return "screen";
    } catch {
      // screen not found either
    }

    this._muxBinary = null;
    return null;
  }

  /**
   * Check if a tmux/screen session is still alive.
   */
  async isSessionAlive(sessionName: string): Promise<boolean> {
    const mux = await this.detectMux();
    if (!mux) return false;

    try {
      if (mux === "tmux") {
        await execAsync("tmux", ["has-session", "-t", sessionName]);
        return true;
      } else {
        const { stdout } = await execAsyncOutput("screen", ["-ls", sessionName]);
        return stdout.includes(sessionName);
      }
    } catch {
      return false;
    }
  }

  // ── Batch spawn ──────────────────────────────────────────────────────────

  /**
   * Spawn a `claude --print` invocation (batch mode — collects full output).
   *
   * Used by CLI chat. For gateway streaming, use `spawnStreaming()` instead.
   */
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const hasImages = options.images && options.images.length > 0;
    return hasImages ? this.spawnStreamJson(options) : this.spawnText(options);
  }

  /**
   * Spawn claude with `--output-format stream-json --include-partial-messages`
   * and relay incremental text to the caller via `onChunk`.
   *
   * Uses an **activity-based timeout**: the process is killed only after
   * `INACTIVITY_TIMEOUT_MS` of silence (no stdout data), not after an
   * absolute duration. A safety cap of `MAX_ABSOLUTE_TIMEOUT_MS` prevents
   * runaway processes.
   */
  async spawnStreaming(
    options: SpawnOptions,
    onChunk?: StreamCallback,
  ): Promise<SpawnResult> {
    const {
      workspace,
      message,
      systemPrompt,
      model,
      images = [],
    } = options;

    const hasImages = images.length > 0;

    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt",
      systemPrompt,
      "--model",
      model,
    ];

    if (hasImages) {
      args.push("--input-format", "stream-json");
    } else {
      args.push("-p", message);
    }

    const env = cleanEnv();

    return new Promise<SpawnResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: workspace,
        env,
        stdio: [hasImages ? "pipe" : "ignore", "pipe", "pipe"],
      });

      this.registerSpawn(options.spawnKey, child);

      let accumulated = "";
      let stderr = "";
      let lastActivity = Date.now();
      let timedOut = false;
      let lineBuffer = "";
      let finalResult = "";

      // If images, send content via stdin
      if (hasImages && child.stdin) {
        const content: Array<
          | { type: "text"; text: string }
          | {
              type: "image";
              source: { type: "base64"; media_type: string; data: string };
            }
        > = [];

        for (const img of images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
              data: img.base64,
            },
          });
        }
        content.push({ type: "text", text: message });

        const stdinPayload =
          JSON.stringify({
            type: "user",
            message: { role: "user", content },
          }) + "\n";

        child.stdin.write(stdinPayload);
        child.stdin.end();
      }

      child.stdout!.on("data", (chunk: Buffer) => {
        lastActivity = Date.now();
        lineBuffer += chunk.toString();

        // Parse complete JSONL lines
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop()!; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Partial text delta — relay to caller
            if (
              event.type === "stream_event" &&
              event.event?.type === "content_block_delta" &&
              event.event?.delta?.type === "text_delta"
            ) {
              accumulated += event.event.delta.text;
              onChunk?.(accumulated);
            }

            // Final result event
            if (event.type === "result" && typeof event.result === "string") {
              finalResult = event.result;
            }
          } catch {
            // skip non-JSON lines
          }
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Activity-based timeout: kill only on silence
      const activityCheck = setInterval(() => {
        if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 5000);
          clearInterval(activityCheck);
        }
      }, 10_000);

      // Absolute safety cap
      const absoluteTimer = setTimeout(() => {
        if (!child.killed) {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 5000);
        }
      }, MAX_ABSOLUTE_TIMEOUT_MS);

      child.on("close", (code) => {
        clearInterval(activityCheck);
        clearTimeout(absoluteTimer);
        this.unregisterSpawn(options.spawnKey, child);

        const exitCode = timedOut ? 124 : (code ?? 1);
        const response = finalResult || accumulated || "";

        const inputChars = message.length + systemPrompt.length;
        const outputChars = response.length;

        resolve({
          response,
          stderr,
          exitCode,
          tokensEstimate: {
            in: Math.ceil(inputChars / 4),
            out: Math.ceil(outputChars / 4),
          },
        });
      });

      child.on("error", (err) => {
        clearInterval(activityCheck);
        clearTimeout(absoluteTimer);
        this.unregisterSpawn(options.spawnKey, child);

        resolve({
          response: "",
          stderr: err.message,
          exitCode: 1,
          tokensEstimate: {
            in: Math.ceil((message.length + systemPrompt.length) / 4),
            out: 0,
          },
        });
      });
    });
  }

  // ── Text-only path (batch — used by CLI chat via spawn()) ───────────────

  private spawnText(options: SpawnOptions): Promise<SpawnResult> {
    const {
      workspace,
      message,
      systemPrompt,
      model,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "-p",
      message,
      "--append-system-prompt",
      systemPrompt,
      "--model",
      model,
    ];

    return new Promise<SpawnResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: workspace,
        env: cleanEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.registerSpawn(options.spawnKey, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        this.unregisterSpawn(options.spawnKey, child);

        const exitCode = timedOut ? 124 : (code ?? 1);
        const inputChars = message.length + systemPrompt.length;
        const outputChars = stdout.length;

        resolve({
          response: stdout,
          stderr,
          exitCode,
          tokensEstimate: {
            in: Math.ceil(inputChars / 4),
            out: Math.ceil(outputChars / 4),
          },
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        this.unregisterSpawn(options.spawnKey, child);

        resolve({
          response: "",
          stderr: err.message,
          exitCode: 1,
          tokensEstimate: {
            in: Math.ceil((message.length + systemPrompt.length) / 4),
            out: 0,
          },
        });
      });
    });
  }

  // ── Image-aware path (stream-json, batch — used by CLI chat via spawn()) ─

  private spawnStreamJson(options: SpawnOptions): Promise<SpawnResult> {
    const {
      workspace,
      message,
      systemPrompt,
      model,
      images = [],
      timeoutMs = IMAGE_TIMEOUT_MS,
    } = options;

    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      systemPrompt,
      "--model",
      model,
    ];

    // Build structured content: images first, then text
    const content: Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: { type: "base64"; media_type: string; data: string };
        }
    > = [];

    for (const img of images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
    content.push({ type: "text", text: message });

    const stdinPayload =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
      }) + "\n";

    return new Promise<SpawnResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: workspace,
        env: cleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.registerSpawn(options.spawnKey, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Write the user message and close stdin to signal completion
      child.stdin.write(stdinPayload);
      child.stdin.end();

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        this.unregisterSpawn(options.spawnKey, child);

        const exitCode = timedOut ? 124 : (code ?? 1);
        const response = parseStreamOutput(stdout);
        const inputChars = message.length + systemPrompt.length;
        const outputChars = response.length;

        resolve({
          response,
          stderr,
          exitCode,
          tokensEstimate: {
            in: Math.ceil(inputChars / 4),
            out: Math.ceil(outputChars / 4),
          },
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        this.unregisterSpawn(options.spawnKey, child);

        resolve({
          response: "",
          stderr: err.message,
          exitCode: 1,
          tokensEstimate: {
            in: Math.ceil((message.length + systemPrompt.length) / 4),
            out: 0,
          },
        });
      });
    });
  }

  /** Kill a tmux/screen async session (used by /stop to cancel async tasks). */
  async killSession(sessionName: string): Promise<boolean> {
    const mux = await this.detectMux();
    if (!mux) return false;

    try {
      if (mux === "tmux") {
        await execAsync("tmux", ["kill-session", "-t", sessionName]);
      } else {
        await execAsync("screen", ["-S", sessionName, "-X", "quit"]);
      }
      return true;
    } catch {
      return false;
    }
  }
}

// ── Utility functions ─────────────────────────────────────────────────────

/** Promise wrapper around execFile. */
function execAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Promise wrapper around execFile that returns stdout. */
function execAsyncOutput(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Stream-json output parser ─────────────────────────────────────────────

/**
 * Extract the assistant's text response from stream-json JSONL output.
 *
 * Looks for a `{"type":"result","result":"..."}` event first (final output),
 * then falls back to collecting text from assistant message content blocks.
 */
export function parseStreamOutput(stdout: string): string {
  const lines = stdout.split("\n").filter(Boolean);

  // 1. Look for a result event (the definitive final output)
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") {
        return event.result;
      }
    } catch {
      // skip non-JSON lines
    }
  }

  // 2. Fallback: collect text from assistant message content blocks
  const textParts: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (
        event.type === "assistant" &&
        Array.isArray(event.message?.content)
      ) {
        for (const block of event.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          }
        }
      }
    } catch {
      // skip non-JSON lines
    }
  }

  if (textParts.length > 0) {
    return textParts.join("");
  }

  // 3. Last resort: return raw stdout
  return stdout;
}
