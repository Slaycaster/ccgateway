# Discord Gateway

## Setup

### 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** → **Reset Token** → copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2** → **URL Generator** → select `bot` scope with permissions: Send Messages, Read Message History, Add Reactions, Use Slash Commands
6. Use the generated URL to invite the bot to your server

### 2. Get your IDs

- **Guild ID** — Right-click your server name → Copy Server ID (enable Developer Mode in Discord settings)
- **Channel ID** — Right-click the channel → Copy Channel ID
- **User ID** — Right-click your username → Copy User ID

### 3. Configure

Add the bot token to `~/.ccgateway/.env`:

```bash
DISCORD_SALT_TOKEN=your-bot-token-here
```

Add the plugin config to `~/.ccgateway/config.json`:

```json
{
  "plugins": [
    {
      "name": "discord-gateway",
      "enabled": true,
      "config": {
        "bots": {
          "salt": { "token": "$DISCORD_SALT_TOKEN" }
        },
        "guild": "YOUR_GUILD_ID",
        "allowedUsers": ["YOUR_USER_ID"],
        "commands": ["/new", "/reset", "/status"]
      }
    }
  ]
}
```

### 4. Bind agent to channel

```json
{
  "bindings": [
    {
      "agent": "salt",
      "gateway": "discord",
      "channel": "CHANNEL_ID",
      "bot": "salt"
    }
  ]
}
```

## Multiple bots

Each agent can have its own Discord bot with its own avatar and display name. Add multiple bot entries:

```json
"bots": {
  "salt": { "token": "$DISCORD_SALT_TOKEN" },
  "pepper": { "token": "$DISCORD_PEPPER_TOKEN" },
  "basil": { "token": "$DISCORD_BASIL_TOKEN" }
}
```

Each bot token corresponds to a separate Discord application, so each agent appears with its own identity in chat.

## Slash commands

Available commands in Discord:

- `/new` — Reset the current session (archive and start fresh)
- `/reset` — Same as `/new`
- `/status` — Show session info for the current channel

## Allowed users

The `allowedUsers` array restricts who can interact with the bots. Only Discord user IDs in this list will have their messages processed. Messages from other users are silently ignored.

## Cross-agent messaging

When an agent sends a message to another agent via `ccg send`, it posts to the target agent's Discord channel using the sender's bot token. The message appears with the sender's bot avatar, and the gateway processes it like any other incoming message.
