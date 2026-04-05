<p align="center">
  <img src="assets/logo.jpg" alt="ccgateway logo" width="600" />
</p>

# ccgateway

**Multi-agent orchestration for Claude Code CLI.**

You have a Claude Code subscription. You want multiple AI agents with their own identities, Discord/Slack channels, persistent conversations, and cross-agent messaging. ccgateway does that by calling `claude --print` under the hood — no API keys, no third-party harness, just your subscription.

## Quick Start

```bash
# Install
npm install -g ccgateway

# New setup
ccg init

# Or migrate from OpenClaw
ccg migrate openclaw

# Add your bot tokens to ~/.ccgateway/.env
# DISCORD_SALT_TOKEN=...
# SLACK_PEPPER_TOKEN=...

# Start as a background service (systemd)
ccg install

# Or run in foreground
source ~/.ccgateway/.env && ccg start
```

### Service Management

```bash
ccg install                # Install and start as systemd user service
ccg uninstall              # Stop and remove the service

# Standard systemd commands also work:
systemctl --user status  ccgateway
systemctl --user restart ccgateway
journalctl --user -u ccgateway -f
```

`ccg install` creates a systemd user service that auto-starts on boot, restarts on failure, and sources `~/.ccgateway/.env` for bot tokens. Run `loginctl enable-linger $USER` to keep it running after you log out.

## Why ccgateway

If you're coming from OpenClaw, you already know what multi-agent orchestration looks like. Same agent identities, same Discord channels, same memory files, same workflows. ccgateway gives you all of that running legitimately on Claude Code CLI.

One command migrates your existing setup:

```bash
ccg migrate openclaw
```

Your agents, channel bindings, bot tokens, heartbeat schedules, and skills carry over. Workspaces and memory files stay exactly where they are. Start the gateway and your agents are back online.

### How is this different?

ccgateway doesn't proxy, wrap, or intercept Claude Code sessions. Every agent invocation is a direct call to `claude --print` — the same CLI binary you run in your terminal, using your Claude Code subscription. ccgateway just manages the plumbing: who talks where, what context gets injected, and where conversation history lives.

## Comparison

| Feature | OpenClaw | ccgateway |
|---|---|---|
| Anthropic ToS compliant | No | **Yes** |
| Uses CC subscription (no API billing) | No | **Yes** |
| Multi-agent identities | Yes | Yes |
| Discord gateway | Yes | Yes |
| Slack gateway | Yes | Yes |
| Session persistence | Yes | Yes |
| Cross-agent messaging | Yes | Yes |
| Memory system | Yes | Yes |
| Skills system | Yes | Yes |
| Heartbeats / cron | Yes | Yes |
| Telegram / WhatsApp | Yes | Roadmap |
| Browser Tools | Yes | Roadmap |
| Migration from OpenClaw | — | **One command** |

## Features

### Multi-Agent Identities

Each agent has its own workspace directory with personality, instructions, and memory. ccgateway points Claude Code at the right workspace — identity comes from your files, not from ccgateway.

```bash
ccg agents add --id salt --name Salt --workspace ~/clawd-salt --model claude-opus-4-6 --emoji "🧂"
ccg agents list
```

Agents read their identity from `CLAUDE.md`, `SOUL.md`, `IDENTITY.md`, and `AGENTS.md` in their workspace. Use whatever combination works for you.

### Discord & Slack Gateways

Each agent can have its own Discord bot (with its own avatar and name) bound to specific channels. Slack works the same way with socket mode — no public URL needed.

```json
{
  "bindings": [
    { "agent": "salt", "gateway": "discord", "channel": "1465736400014938230", "bot": "salt" },
    { "agent": "pepper", "gateway": "slack", "channel": "C07ABC123", "bot": "pepper" }
  ]
}
```

Slash commands in chat: `/new` resets the session, `/reset` does the same, `/status` shows session info.

### Session Persistence

Conversations are stored as JSONL files — one per agent per channel. Sessions never expire. When the context window fills up (default 200k tokens), older messages drop from what gets sent to Claude, but the full history stays on disk.

```bash
ccg sessions list
ccg sessions inspect salt:discord:1465736400014938230
ccg sessions reset salt:discord:1465736400014938230
```

### Cross-Agent Messaging

Agents talk to each other by posting to each other's Discord/Slack channels. Salt's bot posts in Pepper's channel with Salt's avatar — the gateway picks it up and routes it to Pepper like any other message.

```bash
ccg send pepper "RCA done for NHD-10763" --from salt
```

Agents without gateway bindings fall back to a file-based inbox.

### Skills System

Skills are markdown files with instructions that agents can read and follow. Shared skills are available to all agents. Agent-specific skills override shared ones.

```bash
ccg skills list
ccg skills add deploy-to-staging.md
ccg skills add navix-rca.md --agent salt
```

Agents can also create skills from chat — they just write a `.md` file to the skills directory.

### Memory

Memory lives in agent workspaces as plain markdown files. ccgateway injects today's and yesterday's daily logs into each turn so agents have recent context without file reads.

```
~/clawd-salt/
├── CLAUDE.md          # Identity + rules (loaded by CC automatically)
├── MEMORY.md          # Curated long-term memory
└── memory/
    ├── 2026-04-05.md  # Today's log
    └── 2026-04-04.md  # Yesterday's log
```

### Heartbeats

Minimal cron-based agent wakeups. If `HEARTBEAT.md` exists in the workspace, the agent reads it and acts. If nothing needs attention, the response is silently discarded — no tokens wasted on Discord.

```bash
ccg heartbeat install    # Write to system crontab
ccg heartbeat run salt   # Manual trigger
```

### CLI Chat

Test agents locally without Discord or Slack:

```bash
ccg chat salt
```

Same session management, same context building, same agent identity — just in your terminal.

## How It Works

```
┌──────────────────────────────────────────────┐
│              ccgateway (single process)       │
│                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │
│  │ Discord │  │  Slack  │  │  Future     │  │
│  │ Plugin  │  │ Plugin  │  │  Plugins    │  │
│  └────┬────┘  └────┬────┘  └──────┬──────┘  │
│       └────────────┼──────────────┘          │
│                    ↓                         │
│            ┌──────────────┐                  │
│            │   Router     │                  │
│            │  (bindings)  │                  │
│            └──────┬───────┘                  │
│                   ↓                          │
│           ┌───────────────┐                  │
│           │ Session Mgr   │                  │
│           │ (JSONL state) │                  │
│           └───────┬───────┘                  │
│                   ↓                          │
│          ┌─────────────────┐                 │
│          │ Context Builder │                 │
│          │ identity+history│                 │
│          │ +skills+memory  │                 │
│          └────────┬────────┘                 │
│                   ↓                          │
│          ┌─────────────────┐                 │
│          │  claude --print │                 │
│          └─────────────────┘                 │
└──────────────────────────────────────────────┘
```

Every agent invocation is stateless. ccgateway assembles the full context — identity files, conversation history, skill index, memory — and passes it to `claude --print` via `--append-system-prompt`. Claude Code reads `CLAUDE.md` from the workspace automatically. The response gets appended to the session JSONL and routed back to Discord/Slack.

No persistent processes per agent. No session hijacking. No API keys. Just `claude --print` with the right context, in the right directory.

## Migration from OpenClaw

```bash
# Preview what gets imported
ccg migrate openclaw --dry-run

# Run the migration
ccg migrate openclaw
```

### What gets migrated

- **Agents** — IDs, names, emojis, workspaces, model preferences
- **Channel bindings** — All Discord channel-to-agent mappings (from both `bindings[]` and guild channel configs)
- **Bot tokens** — Written to `~/.ccgateway/.env` with actual values from your OpenClaw config
- **Heartbeats** — Cron schedules converted from OpenClaw's job format
- **Discord gateway plugin** — Auto-configured with your bots, guild, and allowed users

### What stays as-is

- Agent workspaces (`CLAUDE.md`, `SOUL.md`, `MEMORY.md`, `memory/`) — untouched
- Git repositories, worktrees, project files — untouched
- Consolidation of `AGENTS.md` + `SOUL.md` + `IDENTITY.md` into `CLAUDE.md` is optional — ccgateway reads all of them

### Both systems can run side by side during transition.

## Plugin Architecture

Gateway channels are plugins. Discord and Slack ship as built-ins. Adding a new gateway means implementing one interface:

```typescript
interface CcgPlugin {
  name: string;
  type: 'gateway' | 'skill' | 'tool';
  init(core: CcgCore): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

Skill plugins handle capabilities that can't be expressed in a markdown file (e.g., browser automation). Tool plugins expose shell commands agents can call.

## Roadmap

- **Telegram gateway** — Plugin for Telegram bot API
- **WhatsApp gateway** — Plugin for WhatsApp Business API
- **Browser Tools** — Playwright-based browser interaction plugin
- **Shared skill packs** — Pre-built skill collections (Obsidian integration, Apple Notes, deployment workflows)
- **Token-accurate context budgeting** — Replace chars/4 estimation with proper tokenizer

## Configuration

Config lives at `~/.ccgateway/config.json` (or `$CCG_HOME/config.json`).

```bash
ccg agents list              # Agents
ccg sessions list            # Active sessions
ccg skills list              # Available skills
ccg status                   # Daemon status
ccg install                  # Install as background service
ccg uninstall                # Remove background service
```

See the [design spec](docs/superpowers/specs/2026-04-05-ccgateway-design.md) for the full configuration reference.

## License

MIT
