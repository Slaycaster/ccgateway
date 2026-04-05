import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CCSpawner, type SpawnResult } from "../spawner.js";

// ── Mock child_process ─────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockedExecFile = vi.mocked(execFile);

// ── Setup ──────────────────────────────────────────────────────────────────

let spawner: CCSpawner;

beforeEach(() => {
  spawner = new CCSpawner();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Configure the mocked execFile to call back with given values.
 */
function mockExecFileResult(
  stdout: string,
  stderr: string = "",
  error: Error | null = null,
): void {
  mockedExecFile.mockImplementation(
    (_cmd: any, _args: any, _opts: any, callback: any) => {
      callback(error, stdout, stderr);
      return undefined as any;
    },
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("spawn — command construction", () => {
  it("constructs correct command arguments", async () => {
    mockExecFileResult("response text");

    await spawner.spawn({
      workspace: "/home/user/project",
      message: "Fix the bug",
      systemPrompt: "You are an assistant",
      model: "sonnet",
      allowedTools: ["Read", "Write", "Bash"],
    });

    expect(mockedExecFile).toHaveBeenCalledTimes(1);

    const [cmd, args] = mockedExecFile.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("-p");
    expect(args).toContain("Fix the bug");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("You are an assistant");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read,Write,Bash");
  });

  it("omits --allowedTools when array is empty", async () => {
    mockExecFileResult("response");

    await spawner.spawn({
      workspace: "/home/user/project",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
    });

    const [, args] = mockedExecFile.mock.calls[0];
    expect(args).not.toContain("--allowedTools");
  });
});

describe("spawn — workspace", () => {
  it("sets cwd to workspace", async () => {
    mockExecFileResult("output");

    await spawner.spawn({
      workspace: "/custom/workspace/path",
      message: "msg",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
    });

    const [, , opts] = mockedExecFile.mock.calls[0];
    expect((opts as any).cwd).toBe("/custom/workspace/path");
  });
});

describe("spawn — output capture", () => {
  it("captures stdout as response", async () => {
    mockExecFileResult("This is the assistant response.");

    const result = await spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
    });

    expect(result.response).toBe("This is the assistant response.");
    expect(result.exitCode).toBe(0);
  });
});

describe("spawn — error handling", () => {
  it("handles non-zero exit code", async () => {
    const error = Object.assign(new Error("Command failed"), { status: 1 });
    mockExecFileResult("partial output", "error output", error);

    const result = await spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
    });

    expect(result.exitCode).toBe(1);
    expect(result.response).toBe("partial output");
  });

  it("returns exit code 124 on timeout", async () => {
    const error = Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" });
    mockExecFileResult("", "", error);

    const result = await spawner.spawn({
      workspace: "/workspace",
      message: "Hello",
      systemPrompt: "Context",
      model: "sonnet",
      allowedTools: [],
      timeoutMs: 1000,
    });

    expect(result.exitCode).toBe(124);
  });
});

describe("spawn — token estimation", () => {
  it("estimates tokens as chars / 4", async () => {
    // message = 20 chars, systemPrompt = 40 chars → input = 60 chars → 15 tokens
    // response = 80 chars → output = 80 chars → 20 tokens
    const message = "x".repeat(20);
    const systemPrompt = "y".repeat(40);
    const response = "z".repeat(80);

    mockExecFileResult(response);

    const result = await spawner.spawn({
      workspace: "/workspace",
      message,
      systemPrompt,
      model: "sonnet",
      allowedTools: [],
    });

    expect(result.tokensEstimate.in).toBe(15);
    expect(result.tokensEstimate.out).toBe(20);
  });

  it("rounds up token estimates", async () => {
    // message = 5 chars, systemPrompt = 2 chars → 7 chars → ceil(7/4) = 2
    // response = 3 chars → ceil(3/4) = 1
    mockExecFileResult("abc");

    const result = await spawner.spawn({
      workspace: "/workspace",
      message: "hello",
      systemPrompt: "ab",
      model: "sonnet",
      allowedTools: [],
    });

    expect(result.tokensEstimate.in).toBe(2);
    expect(result.tokensEstimate.out).toBe(1);
  });
});

describe("spawn — timeout configuration", () => {
  it("passes custom timeout to execFile", async () => {
    mockExecFileResult("output");

    await spawner.spawn({
      workspace: "/workspace",
      message: "msg",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
      timeoutMs: 60000,
    });

    const [, , opts] = mockedExecFile.mock.calls[0];
    expect((opts as any).timeout).toBe(60000);
  });

  it("uses default 5 minute timeout when not specified", async () => {
    mockExecFileResult("output");

    await spawner.spawn({
      workspace: "/workspace",
      message: "msg",
      systemPrompt: "ctx",
      model: "sonnet",
      allowedTools: [],
    });

    const [, , opts] = mockedExecFile.mock.calls[0];
    expect((opts as any).timeout).toBe(300000);
  });
});
