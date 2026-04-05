import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getCcgHome } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ── State ───────────────────────────────────────────────────────────────────

let minLevel: LogLevel = "info";
let fileLogging = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function logFilePath(): string {
  return join(getCcgHome(), "logs", "ccgateway.log");
}

function format(level: LogLevel, message: string): string {
  return `[${timestamp()}] [${level.toUpperCase()}] ${message}`;
}

async function writeToFile(line: string): Promise<void> {
  const path = logFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await appendFile(path, line + "\n", "utf-8");
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Configure the logger.
 */
export function configureLogger(opts: {
  level?: LogLevel;
  file?: boolean;
}): void {
  if (opts.level !== undefined) minLevel = opts.level;
  if (opts.file !== undefined) fileLogging = opts.file;
}

/**
 * Core log function.
 */
async function log(level: LogLevel, message: string): Promise<void> {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const line = format(level, message);

  // Always write to stdout
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }

  // Optionally write to file
  if (fileLogging) {
    await writeToFile(line);
  }
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
