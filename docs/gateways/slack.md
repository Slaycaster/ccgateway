# Slack Gateway

## Setup

### 1. Create a Slack app

1. Go to [Slack API](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Enable **Socket Mode** (no public URL needed)
3. Generate an **App-Level Token** with `connections:write` scope
4. Under **Event Subscriptions**, subscribe to: `message.channels`, `message.groups`, `message.im`
5. Under **OAuth & Permissions**, add bot scopes: `chat:write`, `channels:history`, `groups:history`, `im:history`
6. Install the app to your workspace and copy the **Bot User OAuth Token**

### 2. Configure

Add tokens to `~/.ccgateway/.env`:

```bash
SLACK_DEFAULT_TOKEN=xapp-your-app-level-token
SLACK_DEFAULT_BOT_TOKEN=xoxb-your-bot-token
```

Add the plugin config to `~/.ccgateway/config.json`:

```json
{
  "plugins": [
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
        "allowedUsers": ["YOUR_SLACK_USER_ID"]
      }
    }
  ]
}
```

### 3. Bind agent to channel

```json
{
  "bindings": [
    {
      "agent": "pepper",
      "gateway": "slack",
      "channel": "C07ABC123",
      "bot": "default"
    }
  ]
}
```

## Multiple bots

Like Discord, you can have multiple Slack apps — one per agent. Each appears with its own name and avatar in Slack.

## Allowed users

The `allowedUsers` array accepts Slack user IDs. Only messages from these users are processed.
