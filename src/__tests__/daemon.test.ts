import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDaemonStatus, pidPath } from "../daemon.js";

// ── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
const originalEnv = process.env.CCG_HOME;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccg-daemon-test-"));
  process.env.CCG_HOME = tempDir;
});

afterEach(async () => {
  process.env.CCG_HOME = originalEnv;
  await rm(tempDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("pidPath", () => {
  it("uses CCG_HOME for PID file location", () => {
    const path = pidPath();
    expect(path).toBe(join(tempDir, "ccgateway.pid"));
  });

  it("changes when CCG_HOME changes", () => {
    process.env.CCG_HOME = "/custom/home";
    expect(pidPath()).toBe("/custom/home/ccgateway.pid");
    process.env.CCG_HOME = tempDir;
  });
});

describe("getDaemonStatus", () => {
  it("returns { running: false } when no PID file exists", () => {
    const status = getDaemonStatus();
    expect(status).toEqual({ running: false });
  });

  it("returns { running: false } with pid when process is not running", async () => {
    // Write a PID file with a PID that is (almost certainly) not running
    const fakePid = 99999999;
    await writeFile(join(tempDir, "ccgateway.pid"), String(fakePid), "utf-8");

    const status = getDaemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBe(fakePid);
  });

  it("reads PID from file", async () => {
    const pid = 12345;
    await writeFile(join(tempDir, "ccgateway.pid"), String(pid), "utf-8");

    const status = getDaemonStatus();
    // The PID 12345 is almost certainly not running, but we can verify it was read
    expect(status.pid).toBe(pid);
  });

  it("returns { running: false } for invalid PID file content", async () => {
    await writeFile(join(tempDir, "ccgateway.pid"), "not-a-number", "utf-8");

    const status = getDaemonStatus();
    expect(status).toEqual({ running: false });
  });

  it("detects current process as running", async () => {
    // Write our own PID — the current process IS running
    await writeFile(join(tempDir, "ccgateway.pid"), String(process.pid), "utf-8");

    const status = getDaemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.uptime).toBeDefined();
    expect(typeof status.uptime).toBe("number");
  });
});
