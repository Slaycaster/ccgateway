# Quick Start

Get your first agent running in 5 minutes.

## 1. Create a workspace

```bash
mkdir -p ~/clawd-myagent
```

## 2. Write an identity

Create `~/clawd-myagent/CLAUDE.md`:

```markdown
You are MyAgent, a helpful assistant.

Be concise. Be direct. Get things done.
```

This is the minimum — Claude Code reads `CLAUDE.md` automatically from the workspace directory. You can also use `SOUL.md`, `IDENTITY.md`, and `AGENTS.md` for more structured identity.

## 3. Register the agent

```bash
ccg agents add \
  --id myagent \
  --name MyAgent \
  --workspace ~/clawd-myagent \
  --model claude-sonnet-4-6 \
  --emoji "🤖"
```

## 4. Test locally

```bash
ccg chat myagent
```

This opens a terminal chat session with your agent — same context building, same session management, just without Discord/Slack.

## 5. Connect to Discord (optional)

Add a binding in `~/.ccgateway/config.json`:

```json
{
  "bindings": [
    {
      "agent": "myagent",
      "gateway": "discord",
      "channel": "YOUR_CHANNEL_ID",
      "bot": "myagent"
    }
  ]
}
```

Add the bot token to `~/.ccgateway/.env` and start the daemon:

```bash
source ~/.ccgateway/.env && ccg start
```

Your agent is now live in Discord.

## Next steps

- [Service Management](service-management.md) — Run as a background service
- [Agents](../concepts/agents.md) — Deep dive into agent identity and workspaces
- [Discord Setup](../gateways/discord.md) — Full Discord configuration guide
