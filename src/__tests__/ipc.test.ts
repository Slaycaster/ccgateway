import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIpcServer, sendViaDaemon, socketPath } from "../ipc.js";
import { existsSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";

// ── Helpers ──────────────────────────────────────────────────────────────

// Override CCG_HOME so tests use a temp socket path
const TEST_CCG_HOME = "/tmp/ccg-ipc-test-" + process.pid;

beforeEach(() => {
  process.env.CCG_HOME = TEST_CCG_HOME;
  // Ensure test socket dir exists
  const { mkdirSync } = require("node:fs");
  mkdirSync(TEST_CCG_HOME, { recursive: true });
});

afterEach(() => {
  // Clean up socket
  const sock = socketPath();
  if (existsSync(sock)) {
    try { unlinkSync(sock); } catch {}
  }
  delete process.env.CCG_HOME;
});

// ── IPC round-trip ───────────────────────────────────────────────────────

describe("IPC server and client", () => {
  let server: Server;

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it("sends a message through the daemon and receives ok", async () => {
    const onSend = vi.fn(async () => {});

    server = createIpcServer(onSend);

    // Wait for server to be ready
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const handled = await sendViaDaemon({
      action: "send",
      to: "pepper",
      content: "Hello from salt",
      from: "salt",
    });

    expect(handled).toBe(true);
    expect(onSend).toHaveBeenCalledWith("pepper", "Hello from salt", "salt");
  });

  it("returns error when handler throws", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("Agent not found");
    });

    server = createIpcServer(onSend);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    await expect(
      sendViaDaemon({
        action: "send",
        to: "nonexistent",
        content: "hello",
      }),
    ).rejects.toThrow("Agent not found");
  });

  it("returns false when daemon is not running", async () => {
    // No server started — socket doesn't exist
    const handled = await sendViaDaemon({
      action: "send",
      to: "pepper",
      content: "hello",
    });

    expect(handled).toBe(false);
  });
});
