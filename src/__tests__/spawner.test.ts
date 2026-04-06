import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CCSpawner, parseStreamOutput } from "../spawner.js";
import { EventEmitter } from "node:events";

// ── Mock child_process ─────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

const mockedSpawn = vi.mocked(spawn);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock child process that emits events like a real one. */
function createMockChild(opts?: { withStdin?: boolean }) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; });

  if (opts?.withStdin) {
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };
  }

  return child;
}

/**
 * Set up mockedSpawn to return a child that emits the given output and exits.
 */
function mockSpawnResult(
  stdoutData: string,
  stderrData: string = "",
  exitCode: number = 0,
  opts?: { withStdin?: boolean },
): ReturnType<typeof createMockChild> {
  const child = createMockChild(opts);
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

// ── Tests — text mode (no images) ─────────────────────────────────────────

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

// ── Tests — image mode (stream-json) ──────────────────────────────────────

describe("spawn — image support (stream-json mode)", () => {
  const IMAGES = [
    { base64: "iVBORw0KGgo=", mediaType: "image/png" },
  ];

  it("switches to stream-json args when images are provided", async () => {
    const streamOutput = '{"type":"result","subtype":"success","result":"It is a red square."}\n';
    mockSpawnResult(streamOutput, "", 0, { withStdin: true });

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Describe this image",
      systemPrompt: "You are an assistant",
      model: "sonnet",
      allowedTools: [],
      images: IMAGES,
    });

    await vi.runAllTimersAsync();
    await promise;

    const [cmd, args] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("--verbose");
    // Should NOT use -p for message
    expect(args).not.toContain("-p");
  });

  it("uses pipe for stdin (not ignore)", async () => {
    const streamOutput = '{"type":"result","subtype":"success","result":"OK"}\n';
    mockSpawnResult(streamOutput, "", 0, { withStdin: true });

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Describe this",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
      images: IMAGES,
    });

    await vi.runAllTimersAsync();
    await promise;

    const [, , opts] = mockedSpawn.mock.calls[0];
    expect((opts as any).stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("writes image content blocks to stdin and closes it", async () => {
    const streamOutput = '{"type":"result","subtype":"success","result":"Done"}\n';
    const child = mockSpawnResult(streamOutput, "", 0, { withStdin: true });

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Describe this image",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
      images: IMAGES,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Verify stdin was written to and closed
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);

    // Verify the payload structure
    const payload = JSON.parse(child.stdin.write.mock.calls[0][0].replace(/\n$/, ""));
    expect(payload.type).toBe("user");
    expect(payload.message.role).toBe("user");
    expect(payload.message.content).toHaveLength(2);
    expect(payload.message.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(payload.message.content[1]).toEqual({
      type: "text",
      text: "Describe this image",
    });
  });

  it("extracts response from stream-json result event", async () => {
    const streamOutput = [
      '{"type":"system","subtype":"init","session_id":"abc"}',
      '{"type":"result","subtype":"success","result":"A red square on white background."}',
    ].join("\n") + "\n";

    mockSpawnResult(streamOutput, "", 0, { withStdin: true });

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Describe",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
      images: IMAGES,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.response).toBe("A red square on white background.");
    expect(result.exitCode).toBe(0);
  });

  it("falls back to text mode when images array is empty", async () => {
    mockSpawnResult("plain response");

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "No images here",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
      images: [],
    });

    await vi.runAllTimersAsync();
    await promise;

    const [, args, opts] = mockedSpawn.mock.calls[0];
    expect(args).toContain("-p");
    expect((opts as any).stdio[0]).toBe("ignore");
  });

  it("handles timeout in stream-json mode", async () => {
    const child = createMockChild({ withStdin: true });
    mockedSpawn.mockReturnValue(child as any);

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Describe",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
      images: IMAGES,
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);
    const result = await promise;
    expect(result.exitCode).toBe(124);
  });

  it("handles spawn error in stream-json mode", async () => {
    const child = createMockChild({ withStdin: true });
    mockedSpawn.mockReturnValue(child as any);

    const promise = spawner.spawn({
      workspace: "/workspace",
      message: "Describe",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
      images: IMAGES,
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

// ── Tests — parseStreamOutput ─────────────────────────────────────────────

describe("parseStreamOutput", () => {
  it("extracts text from result event", () => {
    const output = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","result":"Hello world!"}',
    ].join("\n");

    expect(parseStreamOutput(output)).toBe("Hello world!");
  });

  it("falls back to assistant content blocks when no result event", () => {
    const output = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fallback response"}]}}',
    ].join("\n");

    expect(parseStreamOutput(output)).toBe("Fallback response");
  });

  it("concatenates multiple assistant text blocks", () => {
    const output = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Part 1"},{"type":"text","text":" Part 2"}]}}',
    ].join("\n");

    expect(parseStreamOutput(output)).toBe("Part 1 Part 2");
  });

  it("returns raw stdout as last resort", () => {
    expect(parseStreamOutput("raw text output")).toBe("raw text output");
  });

  it("skips non-JSON lines gracefully", () => {
    const output = [
      "not json",
      '{"type":"result","result":"Found it"}',
      "also not json",
    ].join("\n");

    expect(parseStreamOutput(output)).toBe("Found it");
  });

  it("handles empty output", () => {
    expect(parseStreamOutput("")).toBe("");
  });
});
