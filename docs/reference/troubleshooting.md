# Troubleshooting

## Agent not responding

**Check the daemon is running:**
```bash
ccg status
```

**Check the binding exists:**
```bash
ccg agents info <agentId>
```
Verify the channel ID in your binding matches the actual Discord/Slack channel.

**Check bot tokens are loaded:**
```bash
source ~/.ccgateway/.env && echo $DISCORD_SALT_TOKEN
```

**Check logs:**
```bash
journalctl --user -u ccgateway -f
# or if running in foreground, check terminal output
```

## "claude: command not found"

Claude Code CLI must be installed and in your PATH:
```bash
which claude
claude --version
```

## Messages being ignored

**Check allowedUsers:** Only user IDs in the `allowedUsers` array are processed. Messages from other users are silently dropped.

**Check the right channel:** The binding must match the exact channel ID where you're messaging.

**Check Message Content Intent:** For Discord, enable Message Content Intent in the bot's settings in the Developer Portal.

## Session seems stuck

If an agent appears unresponsive in a specific channel:

```bash
# Check the session
ccg sessions inspect agentId:discord:channelId

# Reset if needed
ccg sessions reset agentId:discord:channelId
```

## Async task not completing

**Check if tmux session is alive:**
```bash
tmux list-sessions
```

**Attach to see what's happening:**
```bash
tmux attach -t <session-name>
```

**Check task directory for output:**
```bash
ls ~/.ccgateway/tasks/
```

## Context too large

If agents start losing context or behaving inconsistently, memory and daily log files may be too large. Trim `MEMORY.md` and archive old daily logs.

## Service won't start after reboot

Make sure linger is enabled:
```bash
loginctl enable-linger $USER
```
