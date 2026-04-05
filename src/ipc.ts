import { createServer, createConnection, type Server } from "node:net";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { getCcgHome } from "./config.js";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface IpcRequest {
  action: "send";
  to: string;
  content: string;
  from?: string;
}

export interface IpcResponse {
  ok: boolean;
  error?: string;
}

type SendHandler = (
  toAgent: string,
  content: string,
  fromAgent?: string,
) => Promise<void>;

// ── Paths ──────────────────────────────────────────────────────────────────

export function socketPath(): string {
  return join(getCcgHome(), "ccgateway.sock");
}

// ── Protocol ───────────────────────────────────────────────────────────────
// Client writes JSON + "\n", server processes, replies with JSON + "\n",
// then server closes. Client reads until "end".

const DELIMITER = "\n";

// ── IPC Server (runs inside the daemon) ────────────────────────────────────

export function createIpcServer(onSend: SendHandler): Server {
  const sockPath = socketPath();

  // Clean up stale socket if it exists
  if (existsSync(sockPath)) {
    unlinkSync(sockPath);
  }

  const server = createServer((conn) => {
    let data = "";

    conn.on("data", (chunk) => {
      data += chunk.toString();

      // Process once we see the delimiter
      const idx = data.indexOf(DELIMITER);
      if (idx === -1) return;

      const json = data.slice(0, idx);
      data = ""; // reset

      void (async () => {
        try {
          const req = JSON.parse(json) as IpcRequest;

          if (req.action === "send") {
            await onSend(req.to, req.content, req.from);
            conn.end(JSON.stringify({ ok: true } as IpcResponse) + DELIMITER);
          } else {
            conn.end(
              JSON.stringify({
                ok: false,
                error: `Unknown action: ${(req as any).action}`,
              } as IpcResponse) + DELIMITER,
            );
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`ipc: error handling request: ${errMsg}`);
          try {
            conn.end(
              JSON.stringify({ ok: false, error: errMsg } as IpcResponse) +
                DELIMITER,
            );
          } catch {
            // Connection may already be closed
          }
        }
      })();
    });
  });

  server.listen(sockPath, () => {
    logger.info(`ipc: listening on ${sockPath}`);
  });

  server.on("error", (err) => {
    logger.error(`ipc: server error: ${err.message}`);
  });

  return server;
}

// ── IPC Client (used by CLI) ───────────────────────────────────────────────

/**
 * Send a message to the daemon via IPC.
 * Returns true if the daemon handled it, false if the socket is not available.
 * Throws if the daemon returned an error.
 */
export async function sendViaDaemon(
  req: IpcRequest,
): Promise<boolean> {
  const sockPath = socketPath();

  if (!existsSync(sockPath)) {
    return false;
  }

  return new Promise<boolean>((resolve, reject) => {
    const conn = createConnection(sockPath, () => {
      conn.write(JSON.stringify(req) + DELIMITER);
    });

    let data = "";

    conn.on("data", (chunk) => {
      data += chunk.toString();
    });

    conn.on("end", () => {
      try {
        const json = data.trim();
        if (!json) {
          reject(new Error("Empty response from daemon"));
          return;
        }
        const resp = JSON.parse(json) as IpcResponse;
        if (resp.ok) {
          resolve(true);
        } else {
          reject(new Error(resp.error || "Daemon returned error"));
        }
      } catch {
        reject(new Error("Invalid response from daemon"));
      }
    });

    conn.on("error", (err) => {
      if (
        (err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        resolve(false); // Daemon not running
      } else {
        reject(err);
      }
    });

    // Timeout after 5 minutes (cross-agent messages can take a while)
    conn.setTimeout(300_000, () => {
      conn.destroy();
      reject(new Error("IPC request timed out"));
    });
  });
}
