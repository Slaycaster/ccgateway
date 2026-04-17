# Environment Variables

## CCG_HOME

Override the default config directory (`~/.ccgateway`):

```bash
export CCG_HOME=/custom/path
```

## .env file

Bot tokens and secrets are stored in `~/.ccgateway/.env`. The daemon sources this file on startup.

```bash
# Discord bot tokens (one per bot)
DISCORD_SALT_TOKEN=your-discord-bot-token
DISCORD_PEPPER_TOKEN=another-discord-bot-token

# Slack tokens
SLACK_DEFAULT_TOKEN=xapp-your-app-level-token
SLACK_DEFAULT_BOT_TOKEN=xoxb-your-bot-token
```

Token names in `.env` must match the `$VARIABLE_NAME` references in `config.json` plugin configs.

## Token naming convention

For Discord:
```
DISCORD_{BOTNAME}_TOKEN
```

For Slack:
```
SLACK_{BOTNAME}_TOKEN
SLACK_{BOTNAME}_BOT_TOKEN
```

Where `{BOTNAME}` matches the key in the plugin's `bots` configuration (uppercased).
