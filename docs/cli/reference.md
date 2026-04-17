# CLI Reference

All commands use the `ccg` binary.

## Daemon

| Command | Description |
|---------|-------------|
| `ccg start` | Start the gateway daemon in foreground |
| `ccg stop` | Stop the running daemon |
| `ccg status` | Show daemon status |
| `ccg install` | Install as systemd user service |
| `ccg uninstall` | Remove the systemd service |

## Agents

| Command | Description |
|---------|-------------|
| `ccg agents list` | List all registered agents |
| `ccg agents add` | Add a new agent |
| `ccg agents remove <id>` | Remove an agent |
| `ccg agents info <id>` | Show agent details and workspace validation |

### `ccg agents add` options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--id` | Yes | — | Unique agent identifier |
| `--name` | Yes | — | Display name |
| `--workspace` | Yes | — | Path to workspace directory |
| `--model` | No | `claude-sonnet-4-6` | Claude model |
| `--emoji` | No | — | Display emoji |
| `--maxConcurrentSessions` | No | `4` | Max parallel invocations |

## Sessions

| Command | Description |
|---------|-------------|
| `ccg sessions list [--agent <id>]` | List active sessions |
| `ccg sessions inspect <key>` | View recent messages in a session |
| `ccg sessions reset <key>` | Archive and reset a session |

Session keys use the format: `agentId:source:sourceId`

## Skills

| Command | Description |
|---------|-------------|
| `ccg skills list [--agent <id>]` | List available skills |
| `ccg skills add <file> [--agent <id>]` | Add a skill from a markdown file |
| `ccg skills remove <name> [--agent <id>]` | Remove a skill |

## Cross-Agent Messaging

| Command | Description |
|---------|-------------|
| `ccg send <agent> "message" [--from <agent>]` | Send a message to an agent's channel |
| `ccg send <agent> "message" --direct` | Force file-based inbox delivery |

## Chat

| Command | Description |
|---------|-------------|
| `ccg chat <agentId>` | Interactive terminal chat with an agent |

## Heartbeats

| Command | Description |
|---------|-------------|
| `ccg heartbeat list` | List configured heartbeats |
| `ccg heartbeat install` | Install heartbeat cron jobs |
| `ccg heartbeat uninstall` | Remove heartbeat cron jobs |
| `ccg heartbeat run <agent>` | Manually trigger a heartbeat |

## Migration

| Command | Description |
|---------|-------------|
| `ccg migrate openclaw [--config <path>] [--dry-run]` | Migrate from OpenClaw config |

## Init

| Command | Description |
|---------|-------------|
| `ccg init` | Initialize `~/.ccgateway/` with default config |
