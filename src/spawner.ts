import { spawn } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SpawnResult {
  response: string;
  stderr: string;
  exitCode: number;
  tokensEstimate: { in: number; out: number };
}

export interface SpawnOptions {
  workspace: string;
  message: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  timeoutMs?: number;
}

// ── CCSpawner ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class CCSpawner {
  /**
   * Spawn a `claude --print` invocation.
   *
   * Executes:
   *   claude --print -p "<message>" --append-system-prompt "<context>"
   *          --model <model>
   *
   * stdin is explicitly closed (ignore) to prevent the Claude CLI from
   * waiting for piped input.
   *
   * Captures stdout as the response. Estimates tokens as chars / 4.
   */
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const {
      workspace,
      message,
      systemPrompt,
      model,
      allowedTools,
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

    // allowedTools intentionally omitted — agents have full access
    // since we run with --dangerously-skip-permissions

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

      // Timeout — kill the process if it runs too long
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Force kill after 5s grace period
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
}
