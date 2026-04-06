import { spawn } from "node:child_process";

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
}

/** Callback fired during streaming with the accumulated text so far. */
export type StreamCallback = (accumulated: string) => void;

// ── CCSpawner ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const IMAGE_TIMEOUT_MS = 600_000; // 10 minutes — vision calls on Opus are slower

/** Inactivity timeout: kill if no stdout data for this long. */
const INACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes of silence

/** Absolute safety cap so processes can't run forever. */
const MAX_ABSOLUTE_TIMEOUT_MS = 1_800_000; // 30 minutes

export class CCSpawner {
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

    return new Promise<SpawnResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: workspace,
        stdio: [hasImages ? "pipe" : "ignore", "pipe", "pipe"],
      });

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
