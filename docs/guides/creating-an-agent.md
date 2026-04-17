# Creating an Agent

End-to-end walkthrough for setting up a new agent from scratch.

## 1. Plan the agent

Decide on:
- **Purpose** — What does this agent do?
- **Personality** — How should it communicate?
- **Model** — Opus for complex reasoning, Sonnet for general tasks, Haiku for quick triage
- **Gateway** — Discord, Slack, or CLI-only?

## 2. Create the workspace

```bash
mkdir -p ~/clawd-myagent/memory
```

## 3. Write identity files

At minimum, create `CLAUDE.md`:

```bash
cat > ~/clawd-myagent/CLAUDE.md << 'EOF'
# MyAgent

You are MyAgent, a helpful assistant focused on [purpose].

## Rules
- Be concise and direct
- [Add specific rules]
EOF
```

For richer identity, also create:
- `SOUL.md` — Personality, tone, communication style
- `AGENTS.md` — Operational protocols, session rules, safety boundaries

## 4. Register with ccgateway

```bash
ccg agents add \
  --id myagent \
  --name "MyAgent" \
  --workspace ~/clawd-myagent \
  --model claude-sonnet-4-6 \
  --emoji "🤖"
```

## 5. Test locally

```bash
ccg chat myagent
```

Iterate on the identity files until the agent behaves the way you want.

## 6. Connect to a gateway

### Discord

1. Create a Discord bot and get the token (see [Discord Setup](../gateways/discord.md))
2. Add the token to `~/.ccgateway/.env`:
   ```
   DISCORD_MYAGENT_TOKEN=your-token
   ```
3. Add the bot to your plugin config in `config.json`:
   ```json
   "bots": { "myagent": { "token": "$DISCORD_MYAGENT_TOKEN" } }
   ```
4. Add a binding:
   ```json
   { "agent": "myagent", "gateway": "discord", "channel": "CHANNEL_ID", "bot": "myagent" }
   ```

### Slack

Follow the same pattern — see [Slack Setup](../gateways/slack.md).

## 7. Start the daemon

```bash
ccg stop && source ~/.ccgateway/.env && ccg start
```

Or restart the systemd service:

```bash
systemctl --user restart ccgateway
```

## 8. Add skills (optional)

```bash
ccg skills add my-skill.md --agent myagent
```

Your agent is live.
