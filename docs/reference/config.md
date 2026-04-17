# Configuration Reference

All configuration lives at `~/.ccgateway/config.json` (or `$CCG_HOME/config.json`).

## Full schema

```json
{
  "agents": [],
  "bindings": [],
  "plugins": [],
  "heartbeats": []
}
```

## agents

Array of agent configurations.

```json
{
  "id": "salt",
  "name": "Salt",
  "emoji": "🧂",
  "workspace": "/home/user/clawd-salt",
  "model": "claude-opus-4-6",
  "allowedTools": ["Edit", "Read", "Write", "Bash", "Grep", "Glob"],
  "maxConcurrentSessions": 4,
  "skills": []
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | — | Unique agent identifier |
| `name` | string | Yes | — | Display name |
| `workspace` | string | Yes | — | Absolute path to workspace directory |
| `model` | string | No | `claude-sonnet-4-6` | Claude model ID |
| `emoji` | string | No | `""` | Display emoji |
| `allowedTools` | string[] | No | `["Edit","Read","Write","Bash","Grep","Glob"]` | Allowed Claude Code tools |
| `maxConcurrentSessions` | number | No | `4` | Max parallel invocations |
| `skills` | string[] | No | `[]` | Agent-specific skill names |

## bindings

Maps agents to gateway channels.

```json
{
  "agent": "salt",
  "gateway": "discord",
  "channel": "1465736400014938230",
  "bot": "salt"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent ID |
| `gateway` | string | Yes | Gateway type (`discord` or `slack`) |
| `channel` | string | Yes | Channel ID |
| `bot` | string | Yes | Bot name (matches key in plugin's `bots` config) |

## plugins

Gateway plugin configurations.

### discord-gateway

```json
{
  "name": "discord-gateway",
  "enabled": true,
  "config": {
    "bots": {
      "salt": { "token": "$DISCORD_SALT_TOKEN" }
    },
    "guild": "GUILD_ID",
    "allowedUsers": ["USER_ID"],
    "commands": ["/new", "/reset", "/status"]
  }
}
```

### slack-gateway

```json
{
  "name": "slack-gateway",
  "enabled": true,
  "config": {
    "bots": {
      "default": {
        "token": "$SLACK_DEFAULT_TOKEN",
        "botToken": "$SLACK_DEFAULT_BOT_TOKEN"
      }
    },
    "allowedUsers": ["SLACK_USER_ID"]
  }
}
```

## heartbeats

Scheduled agent check-ins.

```json
{
  "agent": "salt",
  "cron": "0 9,17 * * *",
  "tz": "Asia/Manila"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent ID |
| `cron` | string | Yes | Cron expression |
| `tz` | string | No | Timezone (IANA format) |

Heartbeats read `HEARTBEAT.md` from the agent's workspace. If nothing needs attention, the agent responds with `HEARTBEAT_OK` (silently discarded). Otherwise, output posts to the agent's channel.
