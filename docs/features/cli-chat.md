# CLI Chat

Test agents locally without Discord or Slack.

## Usage

```bash
ccg chat <agentId>
```

This opens an interactive terminal session with the specified agent. It uses the same session management, context building, and agent identity as gateway-connected sessions — just in your terminal.

## Session persistence

CLI chat sessions are persisted like any other session:

```
~/.ccgateway/agents/{agentId}/sessions/cli_default.jsonl
```

The conversation carries over between `ccg chat` invocations. To start fresh:

```bash
ccg sessions reset <agentId>:cli:default
```

## When to use

- **Development** — Test agent behavior before connecting to Discord/Slack
- **Debugging** — Interact with an agent to diagnose issues
- **Quick tasks** — Use an agent without switching to Discord
