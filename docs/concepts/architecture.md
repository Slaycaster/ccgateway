# Architecture

## Overview

ccgateway is a single Node.js process that orchestrates multiple Claude Code agents. It handles message routing, session management, context assembly, and gateway connections — while Claude Code CLI does the actual AI work.

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

## Key design decisions

### Stateless invocations

Every agent turn is a fresh `claude --print` call. ccgateway builds the full context and passes it via `--append-system-prompt`. There are no persistent agent processes — just the CLI, invoked with the right arguments, in the right directory.

This means:
- No memory leaks from long-running agent processes
- Agents can use different models per invocation
- Crash recovery is trivial — just invoke again
- Scaling is limited only by your Claude Code subscription's concurrency

### External session management

Conversation history is stored in JSONL files, one per agent per channel. ccgateway manages the context window — when history exceeds the token budget (default 200k), older messages are dropped from what gets sent to Claude, but the full history stays on disk.

### Identity from files

Agent identity comes from workspace files (`CLAUDE.md`, `SOUL.md`, `IDENTITY.md`, `AGENTS.md`), not from ccgateway configuration. Claude Code reads `CLAUDE.md` automatically; ccgateway injects the rest via system prompt.

### Plugin-based gateways

Discord and Slack are implemented as plugins. Adding a new gateway means implementing the `CcgPlugin` interface — ccgateway handles routing, sessions, and context for you.

## Security model

Chat messages are **untrusted input** that become prompts an agent acts on. ccgateway exposes two distinct controls — get them right and the system stays safe; get them wrong and you are running a remote shell for strangers.

**Authentication — `allowedUsers`** (per gateway plugin)
Only users on this list can talk to the agent at all. Everyone not on it is silently ignored. This is your first and hardest gate: if someone isn't on `allowedUsers`, nothing else in ccgateway matters for them.

**Authorization — `allowedTools`** (per agent)
Once a user is through the gate, their message becomes a prompt. Whatever tools you list in `allowedTools` are the tools the agent can run on their behalf, passed to `claude` as `--allowedTools <tools...>`. A narrow list (`Read, Grep, Glob`) keeps the agent read-only. Including `Bash`, `Write`, or `Edit` means any user on `allowedUsers` can, through social engineering, get the agent to run shell commands, modify files, or overwrite your workspace.

**Permission gating — `dangerouslySkipPermissions`** (per agent)
When `true`, passes `--dangerously-skip-permissions` to `claude`, skipping all runtime permission prompts. Required in practice for `--print` mode (no TTY to approve things), but only safe when paired with a tightly scoped `allowedTools`. New agents created via `ccg agents add` default to `false`; existing agents and OpenClaw migrations default to `true` for back-compat.

**Async (tmux) spawns** unconditionally pass `--dangerously-skip-permissions` — interactive tmux sessions have no way to answer a permission prompt and would hang forever otherwise. The `allowedTools` scope is still applied. Treat channels that can trigger async work as higher-privilege.

**Practical rules of thumb**
- Default `allowedTools` to `Read, Grep, Glob` unless you have a concrete reason to widen it
- Never include `Bash` in `allowedTools` for a channel where `allowedUsers` spans more than trusted individuals
- Review every `ccg agents add --allowedTools ...` with the threat model in mind: would I trust everyone in `allowedUsers` to ssh into this host and run that tool?
- Prefer explicit `--dangerously-skip-permissions` only when you have narrowed `allowedTools` accordingly

## Request lifecycle

1. **Message arrives** — A Discord/Slack plugin receives a message
2. **Routing** — The router matches the channel to an agent via bindings
3. **Session lookup** — Session manager loads or creates the JSONL session file
4. **Triage** (if async enabled) — Quick Haiku call determines sync vs async handling
5. **Context assembly** — Context builder assembles: identity files + conversation history + skill index + memory (today + yesterday daily logs)
6. **Invocation** — `claude --print` is called in the agent's workspace directory
7. **Response handling** — Response is appended to session history and sent back through the gateway
