import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AsyncTaskWatcher, type AsyncTask } from "../async-watcher.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { execSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedReadFile = vi.mocked(readFile);
const mockedRm = vi.mocked(rm);
const mockedExistsSync = vi.mocked(existsSync);

function makeTask(overrides: Partial<AsyncTask> = {}): AsyncTask {
  return {
    sessionName: "ccg-salt-a3f2",
    taskDir: "/tmp/async-tasks/ccg-salt-a3f2",
    agentId: "salt",
    gateway: "discord",
    channel: "123456",
    botId: "salt-bot",
    sessionKey: "salt:discord:123456",
    workspace: "/home/user/project",
    startedAt: Date.now(),
    ...overrides,
  };
}

let sendToChannel: ReturnType<typeof vi.fn>;
let appendToSession: ReturnType<typeof vi.fn>;
let watcher: AsyncTaskWatcher;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sendToChannel = vi.fn(async () => {});
  appendToSession = vi.fn(async () => {});
  watcher = new AsyncTaskWatcher({ sendToChannel, appendToSession });
});

afterEach(() => {
  watcher.stop();
  vi.useRealTimers();
});

describe("register and list", () => {
  it("registers a task", () => {
    const task = makeTask();
    watcher.register(task);
    expect(watcher.listTasks()).toHaveLength(1);
    expect(watcher.listTasks()[0].sessionName).toBe("ccg-salt-a3f2");
  });
});

describe("isSessionAlive", () => {
  it("returns true when tmux session exists", () => {
    mockedExecSync.mockReturnValue("" as any);
    expect((watcher as any).isSessionAlive("ccg-salt-a3f2")).toBe(true);
  });

  it("returns false when tmux session is gone", () => {
    mockedExecSync.mockImplementation(() => { throw new Error("no session"); });
    expect((watcher as any).isSessionAlive("ccg-salt-a3f2")).toBe(false);
  });
});

describe("resolveResult", () => {
  it("reads RESULT.md when it exists", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFile.mockResolvedValue("I refactored the auth module." as any);

    const result = await (watcher as any).resolveResult(makeTask());
    expect(result).toBe("I refactored the auth module.");
  });

  it("falls back to output.log tail when no RESULT.md and summary fails", async () => {
    // existsSync: RESULT.md → false, output.log → true
    mockedExistsSync.mockImplementation((p: any) => {
      return String(p).endsWith("output.log");
    });
    mockedReadFile.mockResolvedValue("line1\nline2\nline3" as any);

    // Mock the Sonnet summary call to fail
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn();
    mockedSpawn.mockReturnValue(child as any);

    const promise = (watcher as any).resolveResult(makeTask());

    // Sonnet summary fails
    process.nextTick(() => {
      child.emit("close", 1);
    });
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe("line1\nline2\nline3");
  });

  it("returns generic message when nothing is available", async () => {
    mockedExistsSync.mockReturnValue(false);

    // Mock summary to fail
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn();
    mockedSpawn.mockReturnValue(child as any);

    const promise = (watcher as any).resolveResult(makeTask());

    process.nextTick(() => {
      child.emit("close", 1);
    });
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe("Task completed but produced no output.");
  });
});

describe("poll cycle", () => {
  it("does nothing when session is still alive", async () => {
    const task = makeTask();
    watcher.register(task);

    // Session is alive
    mockedExecSync.mockReturnValue("" as any);
    await (watcher as any).poll();

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(watcher.listTasks()).toHaveLength(1);
  });

  it("posts result and cleans up when session ends", async () => {
    const task = makeTask();
    watcher.register(task);

    // Session is dead
    mockedExecSync.mockImplementation(() => { throw new Error("gone"); });
    mockedExistsSync.mockImplementation((p: any) => String(p).endsWith("RESULT.md"));
    mockedReadFile.mockResolvedValue("Done! I built the feature." as any);
    mockedRm.mockResolvedValue(undefined);

    await (watcher as any).poll();

    expect(sendToChannel).toHaveBeenCalledWith("123456", "salt-bot", "Done! I built the feature.");
    expect(appendToSession).toHaveBeenCalled();
    expect(mockedRm).toHaveBeenCalledWith(task.taskDir, { recursive: true, force: true });
    expect(watcher.listTasks()).toHaveLength(0);
  });
});

describe("start and stop", () => {
  it("starts polling interval", () => {
    watcher.start();
    expect(watcher.isRunning()).toBe(true);
  });

  it("stops polling interval", () => {
    watcher.start();
    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });

  it("does not start twice", () => {
    watcher.start();
    watcher.start();
    expect(watcher.isRunning()).toBe(true);
    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });
});
