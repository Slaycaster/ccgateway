import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CCSpawner } from "../spawner.js";
import { EventEmitter } from "node:events";

// ── Mock child_process ─────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

const mockedSpawn = vi.mocked(spawn);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock child process that emits events like a real one. */
function createMockChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; });
  return child;
}

/**
 * Set up mockedSpawn to return a child that emits the given output and exits.
 */
function mockSpawnResult(
  stdoutData: string,
  stderrData: string = "",
  exitCode: number = 0,
): ReturnType<typeof createMockChild> {
  const child = createMockChild();
  mockedSpawn.mockReturnValue(child as any);

  // Emit data and close asynchronously
  process.nextTick(() => {
    if (stdoutData) child.stdout.emit("data", Buffer.from(stdoutData));
    if (stderrData) child.stderr.emit("data", Buffer.from(stderrData));
    child.emit("close", exitCode);
  });

  return child;
}

// ── Setup ──────────────────────────────────────────────────────────────────

let spawner: CCSpawner;

beforeEach(() => {
  spawner = new CCSpawner();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("spawn — command construction", () => {
  it("constructs correct command arguments", async () => {
    mockSpawnResult("response text");

    const promise = spawner.spawn({
      workspace: "/home/user/project",
      message: "Fix the bug",
      systemPrompt: "You are an assistant",
      model: "sonnet",
      allowedTools: ["Read", "Write", "Bash"],
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockedSpawn).toHaveBeenCalledTimes(1);

    const [cmd, args] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("-p");
    expect(args).toContain("Fix the bug");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("You are an assistant");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
    expect(args).toContain("--dangerously-skip-permissions");
  });
});

describe("spawn — stdin is closed", () => {
  it("uses stdio ignore for stdin to prevent waiting for input", async () => {
    mockSpawnResult("output");

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "msg",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
    });

    await vi.runAllTimersAsync();
    await promise;

    const [, , opts] = mockedSpawn.mock.calls[0];
    expect((opts as any).stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});

describe("spawn — workspace", () => {
  it("sets cwd to workspace", async () => {
    mockSpawnResult("output");

    const promise = spawner.spawn({
      workspace: "/custom/workspace/path",
      message: "msg",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
    });

    await vi.runAllTimersAsync();
    await promise;

    const [, , opts] = mockedSpawn.mock.calls[0];
    expect((opts as any).cwd).toBe("/custom/workspace/path");
  });
});

describe("spawn — output capture", () => {
  it("captures stdout as response", async () => {
    mockSpawnResult("This is the assistant response.");

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.response).toBe("This is the assistant response.");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    mockSpawnResult("output", "some warning");

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.stderr).toBe("some warning");
  });
});

describe("spawn — error handling", () => {
  it("handles non-zero exit code", async () => {
    mockSpawnResult("partial output", "error output", 1);

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(result.response).toBe("partial output");
    expect(result.stderr).toBe("error output");
  });

  it("handles spawn error event", async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValue(child as any);

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
    });

    process.nextTick(() => {
      child.emit("error", new Error("ENOENT: claude not found"));
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("ENOENT: claude not found");
  });
});

describe("spawn — timeout", () => {
  it("kills process and returns exit code 124 on timeout", async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValue(child as any);

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
      timeoutMs: 5000,
    });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(5000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // Process exits after being killed
    child.emit("close", null);

    const result = await promise;
    expect(result.exitCode).toBe(124);
  });
});

describe("spawn — token estimation", () => {
  it("estimates tokens as chars / 4", async () => {
    const message = "x".repeat(20);
    const systemPrompt = "y".repeat(40);
    const response = "z".repeat(80);

    mockSpawnResult(response);

    const promise = spawner.spawn({
      workspace: "/workspace",
      message,
      systemPrompt,
      model: "sonnet",
      allowedTools: [],
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.tokensEstimate.in).toBe(15);
    expect(result.tokensEstimate.out).toBe(20);
  });

  it("rounds up token estimates", async () => {
    mockSpawnResult("abc");

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "hello",
      systemPrompt: "ab",
      model: "sonnet",
      allowedTools: [],
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.tokensEstimate.in).toBe(2);
    expect(result.tokensEstimate.out).toBe(1);
  });
});
