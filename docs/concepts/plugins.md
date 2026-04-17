# Plugins

ccgateway uses a plugin architecture for gateway connections. Discord and Slack ship as built-in plugins.

## Plugin interface

Every plugin implements the `CcgPlugin` interface:

```typescript
interface CcgPlugin {
  name: string;
  type: 'gateway' | 'skill' | 'tool';
  init(core: CcgCore): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

### Lifecycle

1. **init** — Called once during startup. Receives the `CcgCore` object with access to routing, sessions, and agent config.
2. **start** — Called after all plugins are initialized. Connect to external services here.
3. **stop** — Called during shutdown. Clean up connections.

## Built-in plugins

### discord-gateway

Connects to Discord via discord.js. Supports multiple bot tokens (one per agent), slash commands, and channel bindings.

Configuration in `config.json`:

```json
{
  "name": "discord-gateway",
  "enabled": true,
  "config": {
    "bots": {
      "salt": { "token": "$DISCORD_SALT_TOKEN" },
      "pepper": { "token": "$DISCORD_PEPPER_TOKEN" }
    },
    "guild": "YOUR_GUILD_ID",
    "allowedUsers": ["USER_ID"],
    "commands": ["/new", "/reset", "/status"]
  }
}
```

### slack-gateway

Connects to Slack via socket mode. No public URL needed.

```json
{
  "name": "slack-gateway",
  "enabled": true,
  "config": {
    "bots": {
      "default": { "token": "$SLACK_DEFAULT_TOKEN" }
    },
    "allowedUsers": ["U07ABC123"]
  }
}
```

## Building a custom plugin

See the [Building a Plugin](../guides/building-a-plugin.md) guide for a walkthrough.
