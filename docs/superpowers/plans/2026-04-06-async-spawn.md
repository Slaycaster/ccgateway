# Async Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add async spawn mode so long-running tasks run autonomously in tmux without blocking the gateway or timing out.

**Architecture:** The router triages each message with a quick Sonnet call to decide sync vs async. Async tasks spawn Claude Code in a detached tmux session and return immediately. An `AsyncTaskWatcher` polls for session completion and posts results back to the channel.

**Tech Stack:** Node.js, child_process (spawn/execSync), tmux/screen, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/spawner.ts` | Add `triage()` (quick Sonnet classification) and `spawnAsync()` (tmux spawn) methods |
| `src/async-watcher.ts` | New — polls tmux sessions, resolves results, posts back via gateway |
| `src/router.ts` | Triage step in `route()`, async branch, watcher registration |
| `src/daemon.ts` | Wire up `AsyncTaskWatcher` in daemon startup/shutdown |
| `src/__tests__/spawner.test.ts` | Tests for `triage()` and `spawnAsync()` |
| `src/__tests__/async-watcher.test.ts` | New — watcher polling, result resolution, cleanup tests |
| `src/__tests__/router.test.ts` | Tests for async route path |

---

### Task 1: Triage method on CCSpawner

**Files:**
- Modify: `src/spawner.ts`
- Test: `src/__tests__/spawner.test.ts`

- [ ] **Step 1: Write failing tests for `triage()`**

Add to `src/__tests__/spawner.test.ts`:

```typescript
describe("triage — sync vs async classification", () => {
  it("returns 'sync' for simple questions", async () => {
    mockSpawnResult("sync");

    const promise = spawner.triage("What does this function do?", "sonnet");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("sync");

    const [cmd, args] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
    expect(args).toContain("-p");
  });

  it("returns 'async' for intensive tasks", async () => {
    mockSpawnResult("async");

    const promise = spawner.triage("Refactor the auth module to use JWT", "sonnet");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("async");
  });

  it("defaults to 'sync' on timeout", async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValue(child as any);

    const promise = spawner.triage("Build me an app", "sonnet");

    // Advance past the 15s triage timeout
    await vi.advanceTimersByTimeAsync(15000);
    child.emit("close", null);

    const result = await promise;
    expect(result).toBe("sync");
  });

  it("defaults to 'sync' on unexpected output", async () => {
    mockSpawnResult("I think this is a complex task that would...");

    const promise = spawner.triage("Do something", "sonnet");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("sync");
  });

  it("defaults to 'sync' on spawn error", async () => {
    const child = createMockChild();
    mockedSpawn.mockReturnValue(child as any);

    const promise = spawner.triage("Do something", "sonnet");
    process.nextTick(() => {
      child.emit("error", new Error("ENOENT"));
    });
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe("sync");
  });

  it("trims and lowercases response before matching", async () => {
    mockSpawnResult("  Async  \n");

    const promise = spawner.triage("Build a feature", "sonnet");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("async");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/spawner.test.ts`
Expected: FAIL — `spawner.triage is not a function`

- [ ] **Step 3: Implement `triage()` on CCSpawner**

Add to `src/spawner.ts` after the `spawn()` method:

```typescript
  private static readonly TRIAGE_TIMEOUT_MS = 15_000;
  private static readonly TRIAGE_PROMPT = `Given this user request, will it require intensive coding work (multiple file edits, building features, refactoring, debugging across files) or is it a quick task (answering questions, small edits, short explanations)?

Respond with ONLY the single word "async" or "sync". Nothing else.

User request:`;

  /**
   * Quick Sonnet call to classify a message as "sync" or "async".
   * Defaults to "sync" on any failure.
   */
  async triage(message: string, model: string): Promise<"sync" | "async"> {
    const triageModel = "sonnet";
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "-p",
      `${CCSpawner.TRIAGE_PROMPT} ${message}`,
      "--model",
      triageModel,
      "--bare",
    ];

    return new Promise<"sync" | "async">((resolve) => {
      const child = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let timedOut = false;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, CCSpawner.TRIAGE_TIMEOUT_MS);

      child.on("close", () => {
        clearTimeout(timer);
        if (timedOut) {
          resolve("sync");
          return;
        }
        const trimmed = stdout.trim().toLowerCase();
        resolve(trimmed === "async" ? "async" : "sync");
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve("sync");
      });
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/spawner.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/spawner.ts src/__tests__/spawner.test.ts
git commit -m "feat(spawner): add triage() for sync/async classification"
```

---

### Task 2: Multiplexer detection and spawnAsync on CCSpawner

**Files:**
- Modify: `src/spawner.ts`
- Test: `src/__tests__/spawner.test.ts`

- [ ] **Step 1: Write failing tests for `detectMultiplexer()` and `spawnAsync()`**

Add to `src/__tests__/spawner.test.ts`:

```typescript
// At the top, add execSync mock
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

import { spawn, execSync } from "node:child_process";

const mockedSpawn = vi.mocked(spawn);
const mockedExecSync = vi.mocked(execSync);
```

Then add the test blocks:

```typescript
describe("detectMultiplexer", () => {
  it("returns 'tmux' when tmux is available", () => {
    mockedExecSync.mockReturnValueOnce("/usr/bin/tmux" as any);
    const spawner = new CCSpawner();
    expect((spawner as any).detectMultiplexer()).toBe("tmux");
  });

  it("returns 'screen' when tmux is not available but screen is", () => {
    mockedExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockReturnValueOnce("/usr/bin/screen" as any);
    const spawner = new CCSpawner();
    expect((spawner as any).detectMultiplexer()).toBe("screen");
  });

  it("throws when neither is available", () => {
    mockedExecSync.mockImplementation(() => { throw new Error("not found"); });
    const spawner = new CCSpawner();
    expect(() => (spawner as any).detectMultiplexer()).toThrow(
      "Neither tmux nor screen is installed",
    );
  });
});

describe("spawnAsync", () => {
  beforeEach(() => {
    // Default: tmux available
    mockedExecSync.mockReturnValue("/usr/bin/tmux" as any);
  });

  it("returns sessionName and taskDir immediately", async () => {
    mockedExecSync.mockReturnValue("/usr/bin/tmux" as any);

    const result = await spawner.spawnAsync({
      workspace: "/home/user/project",
      message: "Refactor the auth module",
      systemPrompt: "You are an assistant",
      model: "opus",
      ccgHome: "/home/user/.ccgateway",
      agentId: "salt",
    });

    expect(result.sessionName).toMatch(/^ccg-salt-[a-f0-9]{4}$/);
    expect(result.taskDir).toContain("async-tasks");
    expect(result.taskDir).toContain(result.sessionName);
  });

  it("creates INSTRUCTIONS.md in taskDir", async () => {
    const result = await spawner.spawnAsync({
      workspace: "/home/user/project",
      message: "Build feature X",
      systemPrompt: "You are helpful",
      model: "opus",
      ccgHome: "/tmp/test-ccg",
      agentId: "salt",
    });

    // execSync should have been called with tmux new-session
    const tmuxCalls = mockedExecSync.mock.calls.filter(
      (c) => String(c[0]).includes("tmux new-session"),
    );
    expect(tmuxCalls.length).toBe(1);
    expect(String(tmuxCalls[0][0])).toContain(result.sessionName);
  });

  it("uses screen fallback when tmux is unavailable", async () => {
    mockedExecSync
      .mockImplementationOnce(() => { throw new Error("not found"); }) // which tmux
      .mockReturnValueOnce("/usr/bin/screen" as any) // which screen
      .mockReturnValue("" as any); // screen -dmS ...

    const result = await spawner.spawnAsync({
      workspace: "/home/user/project",
      message: "Build it",
      systemPrompt: "ctx",
      model: "opus",
      ccgHome: "/tmp/test-ccg",
      agentId: "salt",
    });

    const screenCalls = mockedExecSync.mock.calls.filter(
      (c) => String(c[0]).includes("screen -dmS"),
    );
    expect(screenCalls.length).toBe(1);
    expect(result.sessionName).toMatch(/^ccg-salt-[a-f0-9]{4}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/spawner.test.ts`
Expected: FAIL — `spawner.spawnAsync is not a function`

- [ ] **Step 3: Implement `detectMultiplexer()` and `spawnAsync()`**

Add imports at the top of `src/spawner.ts`:

```typescript
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
```

Add the `AsyncSpawnOptions` interface and `AsyncSpawnResult` interface:

```typescript
export interface AsyncSpawnOptions {
  workspace: string;
  message: string;
  systemPrompt: string;
  model: string;
  ccgHome: string;
  agentId: string;
}

export interface AsyncSpawnResult {
  sessionName: string;
  taskDir: string;
}
```

Add methods to `CCSpawner`:

```typescript
  /**
   * Detect available terminal multiplexer. Checks tmux first, then screen.
   * Throws if neither is installed.
   */
  private detectMultiplexer(): "tmux" | "screen" {
    try {
      execSync("which tmux", { stdio: "pipe" });
      return "tmux";
    } catch {
      // tmux not found, try screen
    }
    try {
      execSync("which screen", { stdio: "pipe" });
      return "screen";
    } catch {
      // screen not found either
    }
    throw new Error(
      "Neither tmux nor screen is installed. Install one to use async tasks.",
    );
  }

  /**
   * Spawn Claude Code in a detached tmux/screen session for long-running tasks.
   * Returns immediately with the session name and task directory.
   */
  async spawnAsync(options: AsyncSpawnOptions): Promise<AsyncSpawnResult> {
    const { workspace, message, systemPrompt, model, ccgHome, agentId } = options;
    const mux = this.detectMultiplexer();

    const shortId = randomBytes(2).toString("hex");
    const sessionName = `ccg-${agentId}-${shortId}`;
    const taskDir = join(ccgHome, "async-tasks", sessionName);

    mkdirSync(taskDir, { recursive: true });

    // Write system prompt + result instruction
    const instructions = `${systemPrompt}\n\nWhen you are completely finished with the task, write a concise summary of what you did to: ${join(taskDir, "RESULT.md")}`;
    writeFileSync(join(taskDir, "INSTRUCTIONS.md"), instructions, "utf-8");

    const outputLog = join(taskDir, "output.log");
    const instructionsFile = join(taskDir, "INSTRUCTIONS.md");

    // Escape single quotes in message for shell
    const escapedMessage = message.replace(/'/g, "'\\''");

    if (mux === "tmux") {
      const cmd = `tmux new-session -d -s ${sessionName} -c ${workspace} "claude --dangerously-skip-permissions --append-system-prompt-file '${instructionsFile}' --model ${model} -p '${escapedMessage}' 2>&1 | tee '${outputLog}'"`;
      execSync(cmd, { stdio: "pipe" });
    } else {
      const cmd = `screen -dmS ${sessionName} bash -c "cd '${workspace}' && claude --dangerously-skip-permissions --append-system-prompt-file '${instructionsFile}' --model ${model} -p '${escapedMessage}' 2>&1 | tee '${outputLog}'"`;
      execSync(cmd, { stdio: "pipe" });
    }

    return { sessionName, taskDir };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/spawner.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/spawner.ts src/__tests__/spawner.test.ts
git commit -m "feat(spawner): add spawnAsync() with tmux/screen support"
```

---

### Task 3: AsyncTaskWatcher

**Files:**
- Create: `src/async-watcher.ts`
- Test: `src/__tests__/async-watcher.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/async-watcher.test.ts`:

```typescript
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

import { execSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedReadFile = vi.mocked(readFile);
const mockedRm = vi.mocked(rm);
const mockedExistsSync = vi.mocked(existsSync);

// ── Helpers ────────────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────────

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
    mockedReadFile.mockResolvedValue("I refactored the auth module.");

    const result = await (watcher as any).resolveResult(makeTask());
    expect(result).toBe("I refactored the auth module.");
  });

  it("falls back to output.log tail when no RESULT.md", async () => {
    mockedExistsSync.mockImplementation((p: any) => {
      return String(p).endsWith("output.log");
    });
    mockedReadFile.mockResolvedValue("line1\nline2\nline3");

    // Mock the Sonnet summary call to fail
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn();
    mockedSpawn.mockReturnValue(child as any);

    const promise = (watcher as any).resolveResult(makeTask());

    // Sonnet summary times out
    process.nextTick(() => {
      child.emit("close", 1);
    });
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe("line1\nline2\nline3");
  });
});

describe("poll cycle", () => {
  it("posts result and cleans up when session ends", async () => {
    const task = makeTask();
    watcher.register(task);

    // Session is alive on first check
    mockedExecSync.mockReturnValueOnce("" as any);
    await (watcher as any).poll();
    expect(sendToChannel).not.toHaveBeenCalled();

    // Session is dead on second check
    mockedExecSync.mockImplementation(() => { throw new Error("gone"); });
    mockedExistsSync.mockImplementation((p: any) => String(p).endsWith("RESULT.md"));
    mockedReadFile.mockResolvedValue("Done! I built the feature.");
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/async-watcher.test.ts`
Expected: FAIL — cannot find module `../async-watcher.js`

- [ ] **Step 3: Implement `AsyncTaskWatcher`**

Create `src/async-watcher.ts`:

```typescript
import { execSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AsyncTask {
  sessionName: string;
  taskDir: string;
  agentId: string;
  gateway: string;
  channel: string;
  botId: string;
  sessionKey: string;
  workspace: string;
  startedAt: number;
}

export interface WatcherCallbacks {
  sendToChannel: (channel: string, botId: string, content: string) => Promise<void>;
  appendToSession: (agentId: string, sessionKey: string, content: string, tokens: { in: number; out: number }) => Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;
const OUTPUT_TAIL_CHARS = 2000;
const SUMMARY_TIMEOUT_MS = 30_000;

// ── AsyncTaskWatcher ───────────────────────────────────────────────────────

export class AsyncTaskWatcher {
  private tasks: AsyncTask[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private callbacks: WatcherCallbacks;

  constructor(callbacks: WatcherCallbacks) {
    this.callbacks = callbacks;
  }

  /** Register a new async task to watch. */
  register(task: AsyncTask): void {
    this.tasks.push(task);
    logger.info(`async-watcher: tracking ${task.sessionName} (agent=${task.agentId})`);
  }

  /** List all in-flight tasks. */
  listTasks(): readonly AsyncTask[] {
    return this.tasks;
  }

  /** Start the polling loop. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.poll().catch((err) => {
        logger.error(`async-watcher: poll error: ${(err as Error).message}`);
      });
    }, POLL_INTERVAL_MS);
    logger.info("async-watcher: started");
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Whether the watcher is actively polling. */
  isRunning(): boolean {
    return this.interval !== null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /** Single poll cycle — check all tasks. */
  private async poll(): Promise<void> {
    const completed: AsyncTask[] = [];

    for (const task of this.tasks) {
      if (!this.isSessionAlive(task.sessionName)) {
        completed.push(task);
      }
    }

    for (const task of completed) {
      await this.handleCompletion(task);
    }
  }

  /** Check if a tmux/screen session is still running. */
  private isSessionAlive(sessionName: string): boolean {
    try {
      execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: "pipe" });
      return true;
    } catch {
      // tmux failed — try screen
    }
    try {
      const output = execSync(`screen -ls`, { encoding: "utf-8", stdio: "pipe" });
      return output.includes(sessionName);
    } catch {
      return false;
    }
  }

  /** Handle a completed task: resolve result, post, clean up. */
  private async handleCompletion(task: AsyncTask): Promise<void> {
    logger.info(`async-watcher: ${task.sessionName} completed, resolving result`);

    let result: string;
    try {
      result = await this.resolveResult(task);
    } catch (err) {
      result = `Task completed but failed to retrieve result: ${(err as Error).message}`;
    }

    // Post result to channel
    try {
      await this.callbacks.sendToChannel(task.channel, task.botId, result);
    } catch (err) {
      logger.error(`async-watcher: failed to post result for ${task.sessionName}: ${(err as Error).message}`);
    }

    // Append to session history
    try {
      await this.callbacks.appendToSession(
        task.agentId,
        task.sessionKey,
        result,
        { in: 0, out: Math.ceil(result.length / 4) },
      );
    } catch (err) {
      logger.error(`async-watcher: failed to append session for ${task.sessionName}: ${(err as Error).message}`);
    }

    // Clean up task directory
    try {
      await rm(task.taskDir, { recursive: true, force: true });
    } catch {
      // non-fatal
    }

    // Remove from registry
    this.tasks = this.tasks.filter((t) => t.sessionName !== task.sessionName);
    logger.info(`async-watcher: ${task.sessionName} fully resolved and cleaned up`);
  }

  /**
   * Resolve the result text for a completed task.
   * Priority: RESULT.md > Sonnet summary > output.log tail
   */
  private async resolveResult(task: AsyncTask): Promise<string> {
    // 1. Try RESULT.md
    const resultPath = join(task.taskDir, "RESULT.md");
    if (existsSync(resultPath)) {
      const content = await readFile(resultPath, "utf-8");
      if (content.trim()) return content.trim();
    }

    // 2. Try Sonnet summary of git diff
    try {
      const summary = await this.runSummaryFallback(task.workspace);
      if (summary.trim()) return summary.trim();
    } catch {
      // fall through
    }

    // 3. Tail of output.log
    const logPath = join(task.taskDir, "output.log");
    if (existsSync(logPath)) {
      const log = await readFile(logPath, "utf-8");
      if (log.length > OUTPUT_TAIL_CHARS) {
        return `...\n${log.slice(-OUTPUT_TAIL_CHARS)}`;
      }
      if (log.trim()) return log.trim();
    }

    return "Task completed but produced no output.";
  }

  /** Quick Sonnet call to summarize what was done based on git diff. */
  private runSummaryFallback(workspace: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        "claude",
        [
          "--print",
          "--dangerously-skip-permissions",
          "--bare",
          "--model",
          "sonnet",
          "-p",
          "Summarize what was changed in this workspace based on `git diff HEAD~1` and `git log -1`. Be concise (under 500 words).",
        ],
        { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("summary timed out"));
      }, SUMMARY_TIMEOUT_MS);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) {
          resolve(stdout);
        } else {
          reject(new Error("summary failed"));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/async-watcher.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/async-watcher.ts src/__tests__/async-watcher.test.ts
git commit -m "feat: add AsyncTaskWatcher for monitoring long-running tasks"
```

---

### Task 4: Router integration — triage and async branch

**Files:**
- Modify: `src/router.ts`
- Test: `src/__tests__/router.test.ts`

- [ ] **Step 1: Write failing tests for the async route path**

Add to `src/__tests__/router.test.ts`:

Update imports:

```typescript
import type { CCSpawner, SpawnResult } from "../spawner.js";
import type { AsyncTaskWatcher } from "../async-watcher.js";
```

Update `createMockSpawner` to include `triage` and `spawnAsync`:

```typescript
function createMockSpawner(result?: Partial<SpawnResult>): CCSpawner {
  const defaultResult: SpawnResult = {
    response: "I can help with that!",
    stderr: "",
    exitCode: 0,
    tokensEstimate: { in: 50, out: 10 },
  };
  return {
    spawn: vi.fn(async () => ({ ...defaultResult, ...result })),
    triage: vi.fn(async () => "sync" as const),
    spawnAsync: vi.fn(async () => ({
      sessionName: "ccg-salt-a3f2",
      taskDir: "/tmp/async-tasks/ccg-salt-a3f2",
    })),
  } as unknown as CCSpawner;
}
```

Add mock watcher:

```typescript
function createMockWatcher(): AsyncTaskWatcher {
  return {
    register: vi.fn(),
    listTasks: vi.fn(() => []),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => true),
  } as unknown as AsyncTaskWatcher;
}
```

Update `beforeEach` to include watcher:

```typescript
let watcher: ReturnType<typeof createMockWatcher>;

beforeEach(() => {
  agents = createMockAgents();
  sessions = createMockSessions();
  context = createMockContext();
  spawner = createMockSpawner();
  watcher = createMockWatcher();
  router = new MessageRouter(
    agents,
    sessions,
    context,
    spawner,
    [BINDING_DISCORD, BINDING_SLACK, BINDING_PEPPER],
    watcher,
  );
});
```

Add test block:

```typescript
describe("route — async path", () => {
  it("dispatches to tmux when triage returns async", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("async");

    const message = makeMessage({ content: "Refactor the entire auth system" });
    const result = await router.route(message);

    expect(spawner.triage).toHaveBeenCalled();
    expect(spawner.spawnAsync).toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(watcher.register).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "ccg-salt-a3f2",
        agentId: "salt",
        channel: "123456",
      }),
    );
    expect(result).toContain("[async]");
    expect(result).toContain("ccg-salt-a3f2");
  });

  it("uses sync path when triage returns sync", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("sync");

    const message = makeMessage({ content: "What does this function do?" });
    await router.route(message);

    expect(spawner.triage).toHaveBeenCalled();
    expect(spawner.spawn).toHaveBeenCalled();
    expect(spawner.spawnAsync).not.toHaveBeenCalled();
  });

  it("passes ccgHome and agentId to spawnAsync", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("async");

    const message = makeMessage();
    await router.route(message);

    expect(spawner.spawnAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: AGENT_SALT.workspace,
        model: "sonnet",
        agentId: "salt",
      }),
    );
  });

  it("appends async placeholder to session history", async () => {
    (spawner.triage as ReturnType<typeof vi.fn>).mockResolvedValue("async");

    const message = makeMessage();
    await router.route(message);

    const appendCalls = (sessions.appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(appendCalls).toHaveLength(2); // user + async placeholder
    const assistantMsg = appendCalls[1][2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toContain("[async]");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/router.test.ts`
Expected: FAIL — `MessageRouter` constructor does not accept watcher argument yet

- [ ] **Step 3: Update the router**

In `src/router.ts`, update the constructor and `route()` method:

Add import:

```typescript
import type { AsyncTaskWatcher } from "./async-watcher.js";
import type { AsyncSpawnOptions } from "./spawner.js";
import { getCcgHome } from "./config.js";
```

Update constructor:

```typescript
export class MessageRouter {
  constructor(
    private agents: AgentRegistry,
    private sessions: SessionManager,
    private context: ContextBuilder,
    private spawner: CCSpawner,
    private bindings: BindingConfig[],
    private watcher?: AsyncTaskWatcher,
  ) {}
```

In `route()`, between building context and spawning, add the triage/async branch:

```typescript
    // 5. Build context
    const systemPrompt = await this.context.build(agentId, sessionKey);

    // 5.5 Triage: should this run async?
    const mode = this.watcher
      ? await this.spawner.triage(messageContent, agent.model)
      : "sync" as const;

    if (mode === "async") {
      const { sessionName, taskDir } = await this.spawner.spawnAsync({
        workspace: agent.workspace,
        message: messageContent,
        systemPrompt,
        model: agent.model,
        ccgHome: getCcgHome(),
        agentId,
      });

      // Register with watcher
      const binding = this.bindings.find((b) => b.agent === agentId);
      this.watcher!.register({
        sessionName,
        taskDir,
        agentId,
        gateway: message.from.gateway,
        channel: message.from.channel,
        botId: binding?.bot ?? agentId,
        sessionKey,
        workspace: agent.workspace,
        startedAt: Date.now(),
      });

      const placeholder = `[async] Task dispatched to tmux session \`${sessionName}\`. I'll post the result here when done.`;
      await this.sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content: placeholder,
        ts: Date.now(),
        tokens: { in: 0, out: 0 },
      });

      return placeholder;
    }

    // 6. Spawn claude --print (sync path — unchanged)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/router.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/__tests__/router.test.ts
git commit -m "feat(router): add triage/async branch for long-running tasks"
```

---

### Task 5: Wire up the watcher in the daemon

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Update daemon to create and wire `AsyncTaskWatcher`**

Add import:

```typescript
import { AsyncTaskWatcher } from './async-watcher.js';
```

After creating the router (step 5 in `startDaemon`), create the watcher:

```typescript
  // 5.5 Create async task watcher
  const watcher = new AsyncTaskWatcher({
    sendToChannel: async (channel, botId, content) => {
      const gatewayPlugins = loader.getPluginsByType("gateway");
      for (const plugin of gatewayPlugins) {
        const gw = plugin as Record<string, unknown>;
        if (typeof gw.sendToChannel === "function") {
          try {
            await (gw.sendToChannel as (c: string, b: string, t: string) => Promise<void>)(channel, botId, content);
            return;
          } catch {
            // try next gateway
          }
        }
      }
      logger.error(`async-watcher: no gateway could deliver result to channel ${channel}`);
    },
    appendToSession: async (agentId, sessionKey, content, tokens) => {
      await sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content,
        ts: Date.now(),
        tokens,
      });
    },
  });
```

Update the `MessageRouter` constructor call to pass the watcher:

```typescript
  const router = new MessageRouter(
    registry,
    sessions,
    context,
    spawner,
    config.bindings,
    watcher,
  );
```

Start the watcher after plugins start (after step 8):

```typescript
  // 8.5 Start async task watcher
  watcher.start();
```

Add watcher stop to the shutdown handler:

```typescript
  const shutdown = async (signal: string) => {
    logger.info(`ccgateway received ${signal}, shutting down...`);
    watcher.stop();
    // ... rest of shutdown
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/daemon.ts
git commit -m "feat(daemon): wire up AsyncTaskWatcher in startup/shutdown"
```

---

### Task 6: Integration smoke test

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (282+ tests)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Final commit and push**

```bash
git add -A
git commit -m "feat: async spawn for long-running tasks via tmux

Adds triage (quick Sonnet call to classify sync/async), spawnAsync
(detached tmux/screen session), and AsyncTaskWatcher (polls for
completion, posts results back to channel)."
git push origin master
```
