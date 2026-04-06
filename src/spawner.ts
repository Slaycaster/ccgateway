import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
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

export interface AsyncSpawnOptions {
  workspace: string;
  message: string;
  systemPrompt: string;
  model: string;
  ccgHome: string;
  agentId: string;
}

export interface AsyncSpawnResult {
  sessionName: string;
  taskDir: string;
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
}

// ── CCSpawner ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class CCSpawner {
  private static readonly TRIAGE_TIMEOUT_MS = 15_000;
  private static readonly TRIAGE_PROMPT = `Given this user request, will it require intensive coding work (multiple file edits, building features, refactoring, debugging across files) or is it a quick task (answering questions, small edits, short explanations)?

Respond with ONLY the single word "async" or "sync". Nothing else.

User request:`;

  /**
   * Run a quick `claude --print` with Sonnet to classify a message as
   * "sync" (quick task) or "async" (intensive, long-running).
   *
   * Defaults to "sync" on timeout, unexpected output, or errors.
   */
  async triage(message: string, _model: string): Promise<"sync" | "async"> {
    const triageModel = "sonnet";
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "-p",
      `${CCSpawner.TRIAGE_PROMPT} ${message}`,
      "--model",
      triageModel,
      "--bare",
    ];

    return new Promise<"sync" | "async">((resolve) => {
      const child = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let timedOut = false;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, CCSpawner.TRIAGE_TIMEOUT_MS);

      child.on("close", () => {
        clearTimeout(timer);
        if (timedOut) {
          resolve("sync");
          return;
        }
        const trimmed = stdout.trim().toLowerCase();
        resolve(trimmed === "async" ? "async" : "sync");
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve("sync");
      });
    });
  }

  /**
   * Spawn a `claude --print` invocation.
   *
   * When `images` are provided, uses `--input-format stream-json` to pass
   * image content blocks directly via stdin (avoids the Read-tool
   * round-trip).  Otherwise falls back to the simpler `-p "<message>"` form
   * with stdin closed.
   */
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const hasImages = options.images && options.images.length > 0;
    return hasImages ? this.spawnStreamJson(options) : this.spawnText(options);
  }

  // ── Multiplexer detection ────────────────────────────────────────────

  private detectMultiplexer(): "tmux" | "screen" {
    try {
      execSync("which tmux", { stdio: "pipe" });
      return "tmux";
    } catch {
      // tmux not found, try screen
    }
    try {
      execSync("which screen", { stdio: "pipe" });
      return "screen";
    } catch {
      // screen not found either
    }
    throw new Error(
      "Neither tmux nor screen is installed. Install one to use async tasks.",
    );
  }

  // ── Async spawn (background task via tmux/screen) ───────────────────

  async spawnAsync(options: AsyncSpawnOptions): Promise<AsyncSpawnResult> {
    const { workspace, message, systemPrompt, model, ccgHome, agentId } = options;
    const mux = this.detectMultiplexer();

    const shortId = randomBytes(2).toString("hex");
    const sessionName = `ccg-${agentId}-${shortId}`;
    const taskDir = join(ccgHome, "async-tasks", sessionName);

    mkdirSync(taskDir, { recursive: true });

    // Write system prompt + result instruction
    const instructions = `${systemPrompt}\n\nWhen you are completely finished with the task, write a concise summary of what you did to: ${join(taskDir, "RESULT.md")}`;
    writeFileSync(join(taskDir, "INSTRUCTIONS.md"), instructions, "utf-8");

    const outputLog = join(taskDir, "output.log");
    const instructionsFile = join(taskDir, "INSTRUCTIONS.md");

    // Escape single quotes in message for shell
    const escapedMessage = message.replace(/'/g, "'\\''");

    if (mux === "tmux") {
      const cmd = `tmux new-session -d -s ${sessionName} -c '${workspace}' "claude --dangerously-skip-permissions --append-system-prompt-file '${instructionsFile}' --model ${model} -p '${escapedMessage}' 2>&1 | tee '${outputLog}'"`;
      execSync(cmd, { stdio: "pipe" });
    } else {
      const cmd = `screen -dmS ${sessionName} bash -c "cd '${workspace}' && claude --dangerously-skip-permissions --append-system-prompt-file '${instructionsFile}' --model ${model} -p '${escapedMessage}' 2>&1 | tee '${outputLog}'"`;
      execSync(cmd, { stdio: "pipe" });
    }

    return { sessionName, taskDir };
  }

  // ── Text-only path ────────────────────────────────────────────────────

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
        stdio: ["ignore", "pipe", "pipe"],
      });

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

  // ── Image-aware path (stream-json) ────────────────────────────────────

  private spawnStreamJson(options: SpawnOptions): Promise<SpawnResult> {
    const {
      workspace,
      message,
      systemPrompt,
      model,
      images = [],
      timeoutMs = DEFAULT_TIMEOUT_MS,
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
        stdio: ["pipe", "pipe", "pipe"],
      });

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
