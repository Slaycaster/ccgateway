# Agents

An agent in ccgateway is a Claude Code instance with a dedicated workspace, identity, and configuration.

## Agent configuration

Agents are registered in `~/.ccgateway/config.json`:

```json
{
  "id": "salt",
  "name": "Salt",
  "emoji": "🧂",
  "workspace": "/home/user/clawd-salt",
  "model": "claude-opus-4-6",
  "allowedTools": ["Edit", "Read", "Write", "Bash", "Grep", "Glob"],
  "maxConcurrentSessions": 4
}
```

### Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | — | Unique identifier, used in bindings and CLI commands |
| `name` | Yes | — | Display name |
| `workspace` | Yes | — | Absolute path to the agent's workspace directory |
| `model` | No | `claude-sonnet-4-6` | Claude model to use |
| `emoji` | No | — | Emoji shown in logs and status |
| `allowedTools` | No | `Edit, Read, Write, Bash, Grep, Glob` | Tools the agent can use |
| `maxConcurrentSessions` | No | `4` | Max parallel invocations |
| `skills` | No | `[]` | Agent-specific skill names |

## Workspace structure

The workspace is a regular directory. Claude Code reads `CLAUDE.md` automatically; ccgateway injects the rest.

```
~/clawd-salt/
├── CLAUDE.md          # Primary identity (read by Claude Code automatically)
├── SOUL.md            # Personality and behavioral rules
├── IDENTITY.md        # Name, emoji, avatar metadata
├── AGENTS.md          # Operational rules and protocols
├── MEMORY.md          # Curated long-term memory
├── memory/
│   ├── 2026-04-10.md  # Today's daily log
│   └── 2026-04-09.md  # Yesterday's daily log
└── ...                # Any other files the agent needs
```

All files are optional except that you need at least one identity file so the agent knows who it is.

### Identity files

- **CLAUDE.md** — The main identity file. Claude Code reads this automatically from the working directory. Put core instructions here.
- **SOUL.md** — Personality, tone, communication style, behavioral boundaries.
- **IDENTITY.md** — Metadata: name, emoji, avatar path.
- **AGENTS.md** — Operational rules: session protocols, tool usage, safety rules.

Use whatever combination makes sense. Some agents use only `CLAUDE.md`. Others split identity across all four files.

## Managing agents

```bash
# List all agents
ccg agents list

# Add a new agent
ccg agents add --id myagent --name MyAgent --workspace ~/clawd-myagent

# Remove an agent
ccg agents remove myagent

# Show agent details and workspace validation
ccg agents info myagent
```

## Context injection

On every invocation, ccgateway injects into the system prompt:
1. Contents of `SOUL.md`, `IDENTITY.md`, `AGENTS.md` (if they exist)
2. Today's daily log (`memory/YYYY-MM-DD.md`)
3. Yesterday's daily log
4. Skill index (available skills and their descriptions)
5. Agent roster (other agents available for cross-agent messaging)
6. Conversation history from the JSONL session file

`CLAUDE.md` is not injected — Claude Code reads it automatically from the workspace directory.
