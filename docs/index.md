# ccgateway

**Lean multi-agent gateway sitting on top of your Claude Code CLI.**

Run multiple AI agents — each with their own identity, Discord/Slack channel, persistent conversations, and cross-agent messaging. No API keys. No third-party harness. Just your Claude Code subscription.

## What is ccgateway?

ccgateway is a single Node.js process that routes messages from Discord and Slack to Claude Code agents. Each agent has its own workspace, personality, memory, and skills — ccgateway handles the plumbing so you can focus on building useful agents.

Every AI invocation is stateless: ccgateway assembles the full context (identity, conversation history, skills, memory) and passes it to `claude --print`. No persistent processes per agent. No API keys. Just the Claude Code CLI with the right context, in the right directory.

## How it works

```
Discord/Slack → ccgateway → Router → Session Manager → Context Builder → claude --print
```

Messages arrive from gateway plugins, get routed to the right agent based on channel bindings, and ccgateway builds the full context from the agent's workspace files and conversation history before invoking Claude Code.

## Key features

- **Multi-agent identities** — Each agent has its own workspace with personality, rules, and memory
- **Discord & Slack gateways** — Each agent gets its own bot with its own avatar and name
- **Session persistence** — Conversations stored as JSONL, never expire, context-windowed automatically
- **Cross-agent messaging** — Agents talk to each other through their gateway channels
- **Skills system** — Markdown-based instruction files, shared or agent-specific
- **Memory injection** — Daily logs and long-term memory injected into every turn
- **Async task spawning** — Long-running tasks dispatched to background tmux sessions
- **Plugin architecture** — Gateways are plugins; add new ones by implementing one interface

## Next steps

- [Installation](getting-started/installation.md) — Get ccgateway running
- [Quick Start](getting-started/quick-start.md) — Your first agent in 5 minutes
- [Architecture](concepts/architecture.md) — Understand how it all fits together
