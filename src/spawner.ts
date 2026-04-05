import { execFile } from "node:child_process";

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
   *          --model <model> --allowedTools Tool1,Tool2,...
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
      execFile(
        "claude",
        args,
        {
          cwd: workspace,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          encoding: "utf-8",
        },
        (error, stdout, stderr) => {
          const response = (stdout || "").toString();
          const stderrStr = (stderr || "").toString();
          const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number | string }).code === "ETIMEDOUT"
            ? 124
            : (error as any).status ?? 1
            : 0;

          const inputChars = message.length + systemPrompt.length;
          const outputChars = response.length;

          resolve({
            response,
            stderr: stderrStr,
            exitCode,
            tokensEstimate: {
              in: Math.ceil(inputChars / 4),
              out: Math.ceil(outputChars / 4),
            },
          });
        },
      );
    });
  }
}
