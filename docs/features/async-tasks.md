# Async Task Spawning

Long-running tasks can be dispatched to background tmux sessions, letting the agent work independently while the user continues chatting.

## How it works

1. **Triage** — When a message arrives, a quick Haiku call classifies it as sync or async
2. **Spawn** — Async tasks launch `claude` in interactive mode (not `--print`) inside a detached tmux session with `--dangerously-skip-permissions`
3. **Monitoring** — The `AsyncTaskWatcher` polls every 10 seconds to check if the tmux session is still alive
4. **Completion** — When the session ends, the watcher reads the result (`RESULT.md` or tailed `output.log`) and posts it back to the channel

## Why interactive mode?

Unlike the normal `claude --print` invocations, async tasks run in full interactive mode. This means:
- The agent has full tool access and can make decisions without time pressure
- Humans can attach to the tmux session to observe or intervene: `tmux attach -t <session-name>`
- The agent won't get cut off by streaming timeouts

## Task directory

Each async task gets its own directory:

```
~/.ccgateway/tasks/{taskId}/
├── INSTRUCTIONS.md   # System prompt for the task
├── PROMPT.txt        # The user message that triggered the task
├── RESULT.md         # Agent writes results here (if applicable)
└── output.log        # Full session output
```

## Attaching to a running task

```bash
tmux list-sessions     # Find the session
tmux attach -t <name>  # Attach and watch/interact
```

## Fallback

If tmux isn't available, the spawner checks for GNU Screen as a fallback. If neither is installed, async tasks are not available and messages are handled synchronously.
