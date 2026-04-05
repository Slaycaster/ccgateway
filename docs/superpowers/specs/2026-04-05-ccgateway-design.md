# ccgateway Design Spec

**Date:** 2026-04-05
**Status:** Draft
**Summary:** Multi-agent orchestration layer built on Claude Code CLI. Replaces OpenClaw with a distributable Node/TypeScript CLI app that adds gateway routing (Discord/Slack), session management, cross-agent messaging, skills, and memory persistence on top of CC's `--print` mode.

---

## 1. Architecture Overview

ccgateway is a single-process Node/TypeScript application with a plugin architecture. The core handles session management, agent registry, and message routing. Gateway channels (Discord, Slack) are plugins loaded at startup. Future expansion (Telegram, native skills, tool plugins) follows the same plugin contract.

Every AI invocation is stateless: `claude --print`. ccgateway owns all conversation state externally via JSONL files. CC reads agent identity from the workspace's `CLAUDE.md` automatically (via `cwd`), and ccgateway injects session history + skills + memory via `--append-system-prompt`.

```
┌──────────────────────────────────────────────┐
│              ccgateway (single process)       │
│                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │
│  │ Discord │  │  Slack  │  │  Future     │  │
│  │ Plugin  │  │ Plugin  │  │  Plugins    │  │
│  └────┬────┘  └────┬────┘  └──────┬──────┘  │
│       │            │              │          │
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
│          │ history+skills  │                 │
│          │ +memory+inbox   │                 │
│          └────────┬────────┘                 │
│                   ↓                          │
│          ┌─────────────────┐                 │
│          │  CC Spawner     │                 │
│          │ claude --print  │                 │
│          └─────────────────┘                 │
└──────────────────────────────────────────────┘
```

**Package name:** `ccgateway`
**CLI command:** `ccg`
**Runtime:** Node.js + TypeScript
**AI backend:** Claude Code CLI (`claude --print`) using CC subscription

---

## 2. Directory Structure

```
~/.ccgateway/                          # Or $CCG_HOME
├── config.json                        # Main config
├── agents/
│   └── {agentId}/
│       └── sessions/
│           └── {sessionKey}.jsonl     # Conversation history
├── skills/                            # Shared skills (markdown + native)
│   ├── create-pr.md
│   ├── run-tests.md
│   └── ...
├── plugins/                           # Plugin directory
│   ├── discord-gateway/
│   ├── slack-gateway/
│   └── ...
└── logs/
```

Agent workspaces (where CLAUDE.md, MEMORY.md, memory/ live) are external directories referenced by path in config. ccgateway does not own or manage workspace contents.

---

## 3. Plugin System

### Plugin interface

```typescript
interface CcgPlugin {
  name: string;
  type: 'gateway' | 'skill' | 'tool';
  init(core: CcgCore): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// Core API exposed to plugins
interface CcgCore {
  config: CcgConfig;
  agents: AgentRegistry;         // Lookup agents, get workspace paths
  sessions: SessionManager;      // Find/create sessions, read history
  router: MessageRouter;         // Push incoming messages into the pipeline
  send(agentId: string, message: string): Promise<void>;  // Cross-agent send
}
```

- **Gateway plugins** — Connect to external platforms, normalize incoming messages, route responses back. Implement typing indicators, message splitting, slash commands.
- **Skill plugins** — Register callable skills for capabilities that require code execution beyond markdown instructions (e.g., Playwright QA).
- **Tool plugins** — Expose shell commands/scripts that agents can call via Bash tool.

### Plugin configuration

```json
{
  "plugins": [
    { "name": "discord-gateway", "enabled": true, "config": { ... } },
    { "name": "slack-gateway", "enabled": true, "config": { ... } }
  ]
}
```

Plugins are loaded from config at startup. Disabled plugins are skipped.

---

## 4. Agent Registry

### Agent definition

```json
{
  "agents": [
    {
      "id": "salt",
      "name": "Salt",
      "emoji": "🧂",
      "workspace": "/home/fdenimar/clawd-salt",
      "model": "claude-opus-4-6",
      "skills": ["create-pr", "run-tests"],
      "allowedTools": ["Edit", "Read", "Write", "Bash", "Grep", "Glob"],
      "maxConcurrentSessions": 4
    }
  ]
}
```

### Identity via workspace

Agent personality and rules come from the workspace's `CLAUDE.md`, not from ccgateway. Each agent workspace contains:

- `CLAUDE.md` — Rules, instructions, identity (replaces AGENTS.md + SOUL.md + IDENTITY.md)
- `MEMORY.md` — Curated long-term memory
- `memory/` — Daily logs (YYYY-MM-DD.md)

ccgateway points CC at the correct workspace via `cwd`. CC loads `CLAUDE.md` automatically.

### CC invocation

```bash
cd <agent.workspace> && claude --print \
  -p "<new message>" \
  --append-system-prompt "$(ccg context build <agentId> <sessionKey>)" \
  --model <agent.model> \
  --allowedTools <agent.allowedTools>
```

### Agent CLI

```
ccg agents list
ccg agents add --id <id> --name <name> --workspace <path> --model <model>
ccg agents remove <id>
ccg agents info <id>
```

---

## 5. Session Management

### Session lifecycle

```
Message arrives (Discord/Slack/CLI)
  → Router resolves agent from bindings
  → Session manager: find or create session
  → Context builder: assemble history + skills + inbox
  → Spawn claude --print
  → Capture response
  → Append user message + response to session JSONL
  → Route response back to source
```

### Session key format

`{agentId}:{source}:{sourceId}`

Examples:
- `salt:discord:1465736400014938230`
- `pepper:slack:C07ABC123`
- `salt:cli:manual`

### JSONL format

Each line in `~/.ccgateway/agents/{agentId}/sessions/{sessionKey}.jsonl`:

```json
{"role": "user", "content": "Fix the export bug", "ts": 1712345678000, "source": "discord", "sourceUser": "Den", "sourceMessageId": "123456"}
{"role": "assistant", "content": "I'll look into the export handler...", "ts": 1712345680000, "tokens": {"in": 4200, "out": 1800}}
```

### Context window management

Sessions never expire. On each turn, ccgateway estimates total context size (system prompt + CLAUDE.md + skills + history + new message) using a fast approximation (chars / 4). If it exceeds the token budget (configurable, default 200k), oldest messages are dropped from the context sent to CC.

The JSONL file itself is append-only and never truncated. Only the context window sent to CC gets windowed. Full history remains on disk.

### Manual session reset

Users can reset sessions from Discord/Slack via `/new` or `/reset` slash commands. This archives the current JSONL (renamed with timestamp) and starts a fresh session.

### Session CLI

```
ccg sessions list [--agent <id>]
ccg sessions inspect <sessionKey>
ccg sessions reset <sessionKey>
```

---

## 6. Gateway Plugins & Message Routing

### Binding configuration

```json
{
  "bindings": [
    {
      "agent": "salt",
      "gateway": "discord",
      "channel": "1465736400014938230",
      "bot": "salt"
    },
    {
      "agent": "pepper",
      "gateway": "slack",
      "channel": "C07ABC123",
      "bot": "pepper"
    }
  ]
}
```

### Discord gateway plugin

```json
{
  "name": "discord-gateway",
  "enabled": true,
  "config": {
    "bots": {
      "salt": { "token": "$DISCORD_SALT_TOKEN" },
      "pepper": { "token": "$DISCORD_PEPPER_TOKEN" },
      "ginger": { "token": "$DISCORD_GINGER_TOKEN" }
    },
    "guild": "1465668382765350966",
    "allowedUsers": ["417671688587706378"],
    "commands": ["/new", "/reset", "/status"]
  }
}
```

- Bot tokens stored as env var references
- Each bot is a separate Discord application (own avatar/name)
- Guild-level scoping with user allowlist

### Slack gateway plugin

```json
{
  "name": "slack-gateway",
  "enabled": true,
  "config": {
    "bots": {
      "salt": { "token": "$SLACK_SALT_TOKEN", "signingSecret": "$SLACK_SALT_SECRET" }
    },
    "workspace": "T07ABC123",
    "allowedUsers": ["U07ABC123"],
    "commands": ["/new", "/reset", "/status"]
  }
}
```

### Normalized message format

Gateway plugins normalize platform messages to:

```typescript
interface IncomingMessage {
  from: {
    gateway: string;       // "discord" | "slack"
    channel: string;       // channel ID
    user: string;          // display name
    userId: string;        // platform user ID
    messageId: string;     // platform message ID
  };
  to: { agent: string };   // resolved from bindings
  content: string;
  attachments: Attachment[];
}
```

### Platform-specific behavior

- **Discord:** Split long responses at paragraph/code block boundaries (2000 char limit). Typing indicator while CC runs. File attachments for large output.
- **Slack:** Slack blocks for formatted output. Thread support. Spinner emoji reaction while processing.
- **Slash commands:** `/new` and `/reset` archive current session JSONL and start fresh. `/status` shows agent session info.

---

## 7. Cross-Agent Messaging

### Channel-native messaging

Cross-agent messages are posted directly to the target agent's gateway channel. The gateway picks them up like any other message. No separate inbox system for gateway-connected agents.

```
Salt wants to tell Pepper something
  → ccg send pepper "RCA done for NHD-10763"
  → Lookup Pepper's primary binding (discord channel)
  → Post to channel using Salt's bot token
  → Discord gateway sees message in Pepper's channel
  → Normal flow: route to Pepper → context → CC → respond
```

The sending agent's bot token is used to post, so the message appears with the sender's avatar and name in Discord/Slack.

### Fallback for non-gateway agents

Agents without a gateway binding use file-based inbox:

```
~/.ccgateway/agents/{agentId}/inbox.jsonl
```

```json
{"from": "salt", "content": "RCA done", "ts": 1712345678000, "read": false}
```

Unread inbox messages are included in the context builder's `--append-system-prompt` output.

### CLI

```
ccg send <agent> "message"             # Post to agent's primary channel
ccg send <agent> "message" --direct    # File-based inbox fallback
```

---

## 8. Skills System

### Markdown skills

Stored as `.md` files with frontmatter:

```markdown
---
name: create-pr
description: Create a pull request with conventional format
---

When creating a PR:
1. Run git status to check changes
2. Create PR using gh pr create...
```

### Native skills (plugins)

For capabilities requiring code execution:

```typescript
interface SkillPlugin extends CcgPlugin {
  type: 'skill';
  skills: Skill[];
}

interface Skill {
  name: string;
  description: string;
  execute(context: { agentId: string; sessionKey: string; args: string[] }): Promise<string>;
}
```

### Skill discovery

On each CC invocation, the context builder includes a skill index:

```
--- Available Skills ---
- create-pr: Create a pull request with conventional format
- run-tests: Run test suite and report results
- playwright-qa: Run browser QA tests with screenshots [native]
```

Agents read full markdown skills via the Read tool. Native skills are invoked via `ccg skill run <name> [args]` through Bash.

### Skill directories

```
~/.ccgateway/skills/                    # Shared skills
~/.ccgateway/agents/{agentId}/skills/   # Agent-specific (overrides shared)
```

### Creating skills from chat

Agents write skill files directly using their normal file tools. No special mechanism needed.

### Skill CLI

```
ccg skills list [--agent <id>]
ccg skills add <file> [--agent <id>]
ccg skills remove <name>
```

---

## 9. Memory Persistence

### Workspace-native memory

Memory files live in each agent's workspace. ccgateway does not own memory files.

- `CLAUDE.md` — Loaded by CC automatically via workspace `cwd`
- `MEMORY.md` — Referenced in CLAUDE.md, read by CC
- `memory/YYYY-MM-DD.md` — Daily logs

### Context builder memory injection

Since every invocation is stateless, the context builder injects recent memory via `--append-system-prompt`:

```
--- Memory ---
Today's date: 2026-04-05
Daily log: memory/2026-04-05.md (create if missing, append observations)
```

Contents of today's and yesterday's daily logs are included so the agent has recent context without file reads.

### No migration needed

Memory files are already markdown in agent workspaces. They carry over as-is.

---

## 10. Heartbeat System

### Cron-based heartbeats

System cron invokes ccgateway on schedule:

```bash
ccg heartbeat <agentId>
```

This:
1. Reads agent's `HEARTBEAT.md` from workspace (if exists)
2. Spawns `claude --print` with prompt: "Read HEARTBEAT.md. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK."
3. If response is `HEARTBEAT_OK` — discard silently (no tokens spent on Discord)
4. If actual output — post to agent's primary channel

### Configuration

```json
{
  "heartbeats": [
    { "agent": "ginger", "cron": "0 9,17 * * *", "tz": "Asia/Manila" },
    { "agent": "salt", "cron": "0 9 * * 1-5", "tz": "Asia/Manila" }
  ]
}
```

### Heartbeat CLI

```
ccg heartbeat install              # Write to system crontab
ccg heartbeat uninstall            # Remove from crontab
ccg heartbeat list                 # Show configured heartbeats
ccg heartbeat run <agent>          # Manual trigger
```

Generated crontab entries:

```
0 9,17 * * * TZ=Asia/Manila ccg heartbeat ginger
0 9 * * 1-5 TZ=Asia/Manila ccg heartbeat salt
```

---

## 11. OpenClaw Migration

### Migration command

```
ccg migrate openclaw [--config <path>] [--dry-run]
```

Reads from `~/.openclaw/` and agent workspaces. Read-only on OpenClaw files.

### What gets migrated

1. **Agent registry** — `openclaw.json` → `agents.list` → agent IDs, names, emojis, workspaces, model preferences
2. **Bindings** — `openclaw.json` → `bindings[]` → channel-to-agent mappings
3. **Bot tokens** — Discord account configs → prompts user to set env vars, writes references
4. **Heartbeats** — `cron/jobs.json` → heartbeat config
5. **Skills** — Copies shared skills from workspace `skills/` directories

### What stays as-is

- Agent workspaces (CLAUDE.md, MEMORY.md, memory/) — untouched
- Consolidation of AGENTS.md + SOUL.md + IDENTITY.md into CLAUDE.md is left to the user

### Both systems can run side by side during transition.

---

## 12. CLI Command Reference

```
# Daemon
ccg start                              # Start gateway daemon
ccg stop                               # Stop daemon
ccg status                             # Running state, gateways, sessions

# Setup
ccg init                               # New user onboarding
ccg migrate openclaw [--dry-run]       # OpenClaw migration

# Agents
ccg agents list
ccg agents add --id <id> --name <name> --workspace <path> --model <model>
ccg agents remove <id>
ccg agents info <id>

# Sessions
ccg sessions list [--agent <id>]
ccg sessions inspect <sessionKey>
ccg sessions reset <sessionKey>

# Messaging
ccg send <agent> "message"
ccg chat <agent>                       # Local REPL for testing

# Skills
ccg skills list [--agent <id>]
ccg skills add <file> [--agent <id>]
ccg skills remove <name>

# Heartbeats
ccg heartbeat install
ccg heartbeat uninstall
ccg heartbeat list
ccg heartbeat run <agent>
```
