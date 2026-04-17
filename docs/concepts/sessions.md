# Sessions

Sessions are persistent conversation histories between an agent and a channel.

## Session keys

Every session is identified by a key in the format:

```
agentId:source:sourceId
```

Examples:
- `salt:discord:1465736400014938230` — Salt's session in a Discord channel
- `pepper:slack:C07ABC123` — Pepper's session in a Slack channel
- `salt:cli:default` — Salt's local CLI chat session

## Storage

Sessions are stored as JSONL (JSON Lines) files:

```
~/.ccgateway/agents/{agentId}/sessions/{source}_{sourceId}.jsonl
```

Each line is a JSON object representing one message:

```json
{"role": "user", "content": "What's the status?", "timestamp": "2026-04-10T14:30:00Z", "author": "Den"}
{"role": "assistant", "content": "All systems green.", "timestamp": "2026-04-10T14:30:05Z"}
```

## Context windowing

Sessions never expire and never get truncated on disk. When the conversation history exceeds the token budget (default 200k characters / 4 ≈ 50k tokens), ccgateway drops older messages from what gets sent to Claude. The full history always stays on disk.

This means you can always go back and read the full conversation, even if the agent only "remembers" the recent portion.

## Managing sessions

```bash
# List active sessions
ccg sessions list [--agent <id>]

# View recent messages
ccg sessions inspect salt:discord:1465736400014938230

# Reset (archive and start fresh)
ccg sessions reset salt:discord:1465736400014938230
```

Resetting a session archives the JSONL file and starts a new one. The old conversation is preserved but the agent starts with a clean slate.
