# Async Spawn: Long-Running Task Support

## Problem

The current `claude --print` spawner is synchronous — the gateway blocks until Claude Code finishes, and the 5-minute default timeout kills intensive tasks (refactors, feature builds, multi-file debugging). Users need a way to dispatch long-running tasks that run autonomously without blocking the gateway or timing out.

## Solution

Add an async spawn mode that:

1. Triages incoming messages with a quick Sonnet call to decide sync vs async
2. For async tasks, spawns Claude Code in a detached tmux session with `--dangerously-skip-permissions`
3. Returns immediately with a placeholder message (including tmux session name for live monitoring)
4. A background watcher detects when the task completes and posts the result back to the channel

## Architecture

### Triage (spawner.triage)

A new method on `CCSpawner` that runs a quick `claude --print` with Sonnet to classify a message as `"sync"` or `"async"`.

- Model: `sonnet` (fast, cheap)
- Timeout: 15 seconds
- Prompt: asks whether the task requires intensive coding work or is quick
- Response: expects `"async"` or `"sync"` only
- Fallback: defaults to `"sync"` on any failure (timeout, parse error, etc.)

### Async Spawn (spawner.spawnAsync)

A new method on `CCSpawner` that launches Claude Code in a detached tmux session.

**Session naming:** `ccg-<agentId>-<shortId>` (e.g. `ccg-salt-a3f2`)

**Task directory:** `$CCG_HOME/async-tasks/<sessionName>/` containing:
- `INSTRUCTIONS.md` — system prompt + instruction to write `RESULT.md` when done
- `output.log` — captured stdout/stderr via `tee`
- `RESULT.md` — written by Claude Code when it finishes (best-case)

**Terminal multiplexer detection:** checks for `tmux` first via `which tmux`, falls back to `screen` via `which screen`, throws an error if neither is available. Detection is done once at startup and cached.

**Spawn command (tmux):**
```bash
tmux new-session -d -s <sessionName> -c <workspace> \
  "claude --dangerously-skip-permissions \
    --append-system-prompt-file <taskDir>/INSTRUCTIONS.md \
    --model <model> 2>&1 | tee <taskDir>/output.log"
```

**Spawn command (screen fallback):**
```bash
screen -dmS <sessionName> bash -c \
  "cd <workspace> && claude --dangerously-skip-permissions \
    --append-system-prompt-file <taskDir>/INSTRUCTIONS.md \
    --model <model> 2>&1 | tee <taskDir>/output.log"
```

**Session detection (screen fallback):** `screen -ls <sessionName>` — check if session appears in the list (exit code and output parsing).

Uses interactive mode (not `--print`) with `--dangerously-skip-permissions` so the human can attach to the tmux session to monitor progress and interact. The task is communicated via `INSTRUCTIONS.md` (system prompt). No inactivity timeout from ccgateway — the session runs until Claude Code exits or the human ends it.

**Returns immediately** with `{ sessionName, taskDir }`.

**tmux sessions are never auto-killed** — they end naturally when Claude Code exits. Since we detect completion by the session ending, the session is already gone at that point.

### AsyncTaskWatcher

A new class (`src/async-watcher.ts`) that runs in the daemon process and monitors in-flight async tasks.

**Task registry:** each entry tracks:
- `sessionName` — tmux session name
- `taskDir` — path to task directory
- `agentId` — which agent owns this task
- `gateway` — originating gateway (discord/slack)
- `channel` — originating channel ID
- `botId` — which bot to post as
- `startedAt` — timestamp

**Polling:** every 10 seconds, checks each registered tmux session via `tmux has-session -t <name>` (exit code 0 = alive, 1 = ended).

**On task completion** (session ended), result resolution in priority order:
1. Read `<taskDir>/RESULT.md` — Claude's own summary of what it did
2. Run a quick `claude --print` fallback with Sonnet: summarize based on git diff in the workspace (30s timeout)
3. Post the last ~2000 characters of `<taskDir>/output.log` (raw output, truncated)

**Posting results:** uses the gateway plugin's `sendToChannel(channel, botId, result)` directly — bypasses the router since we're just delivering output, not routing a new message.

**After posting:**
- Appends the assistant response to the session history
- Cleans up `<taskDir>` (instructions, output log, result file)

**Lifecycle:** created in `startDaemon()`, stopped on shutdown (clears the polling interval).

**Concurrency:** no limit on concurrent async tasks — all run in parallel.

### Router Integration

The `route()` method gains a triage step between context building and spawning:

```
Build context
  -> Triage (quick Sonnet call: sync or async?)
  -> If sync: existing flow (unchanged)
  -> If async:
     1. spawner.spawnAsync(...)
     2. watcher.register(task)
     3. Append placeholder to session history
     4. Return placeholder text immediately
```

**Placeholder message format:**
```
[async] Task dispatched to tmux session `ccg-salt-a3f2`. I'll post the result here when done.
```

The router receives an `AsyncTaskWatcher` reference via constructor injection (same pattern as other dependencies).

## Data Flow

```
User sends message in Discord/Slack
  -> Gateway builds IncomingMessage
  -> Router.route()
    -> Append user message to session
    -> Download attachments
    -> Build context
    -> spawner.triage(message) -> Sonnet returns "async"
    -> spawner.spawnAsync({...}) -> starts tmux, returns { sessionName, taskDir }
    -> watcher.register({ sessionName, taskDir, channel, botId, ... })
    -> Append "[async] dispatched to ccg-salt-a3f2" to session
    -> Return placeholder text immediately
  -> Gateway posts placeholder to channel

  ... Claude Code runs autonomously in tmux ...
  ... writes RESULT.md when done ...
  ... tmux session ends ...

  -> AsyncTaskWatcher poll detects session ended
    -> Reads RESULT.md (or Sonnet summary fallback, then output.log tail)
    -> sendToChannel(channel, botId, result)
    -> Append assistant response to session history
    -> Clean up taskDir
```

## Files

| File | Change |
|------|--------|
| `src/spawner.ts` | Add `triage()` and `spawnAsync()` methods |
| `src/async-watcher.ts` | New file — `AsyncTaskWatcher` class |
| `src/router.ts` | Triage step, async branch, watcher registration |
| `src/daemon.ts` | Create and wire up the watcher |
| `src/__tests__/spawner.test.ts` | Tests for triage and spawnAsync |
| `src/__tests__/async-watcher.test.ts` | New file — watcher tests |
| `src/__tests__/router.test.ts` | Tests for async route path |
