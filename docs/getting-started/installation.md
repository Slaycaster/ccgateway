# Installation

## Prerequisites

- **Node.js** 18+ and npm
- **Claude Code CLI** installed and authenticated (`claude --version` should work)
- A **Claude Max or Pro subscription** (ccgateway uses your Claude Code subscription, not API keys)
- **tmux** (optional, for async task spawning)

## Install

```bash
npm install -g ccgateway
```

## Initialize

```bash
ccg init
```

This creates `~/.ccgateway/` with a default `config.json` and directory structure.

## Bot tokens

Add your Discord and/or Slack bot tokens to `~/.ccgateway/.env`:

```bash
# Discord
DISCORD_SALT_TOKEN=your-discord-bot-token-here
DISCORD_PEPPER_TOKEN=another-bot-token

# Slack
SLACK_DEFAULT_TOKEN=xapp-your-slack-app-token
```

Each Discord agent can have its own bot (with its own avatar and name). Slack uses socket mode — no public URL needed.

## Verify

```bash
source ~/.ccgateway/.env && ccg status
ccg agents list
```

## Next steps

- [Quick Start](quick-start.md) — Create your first agent
- [Service Management](service-management.md) — Run ccgateway as a background service
