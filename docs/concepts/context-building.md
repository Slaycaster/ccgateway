# Context Building

Context building is the process of assembling everything an agent needs to know for a single invocation. This happens on every turn — there's no persistent state between invocations.

## What gets assembled

For each `claude --print` call, ccgateway builds a system prompt containing:

1. **Identity files** — `SOUL.md`, `IDENTITY.md`, `AGENTS.md` from the agent's workspace (injected via `--append-system-prompt`)
2. **Memory** — Today's and yesterday's daily logs (`memory/YYYY-MM-DD.md`)
3. **Skills** — A skill index listing available skills with descriptions, plus any auto-loaded skill content
4. **Agent roster** — List of other agents available for cross-agent messaging
5. **Session metadata** — Session key, source info, channel context
6. **Conversation history** — Recent messages from the JSONL session file, within the token budget

`CLAUDE.md` is **not** injected by ccgateway — Claude Code reads it automatically from the workspace directory.

## Order of injection

The system prompt is assembled in this order:

```
SOUL.md content
---
IDENTITY.md content
---
AGENTS.md content
---
Skill index
---
Agent roster
---
Memory (today + yesterday daily logs)
---
Session context
---
Conversation history
---
Current user message
```

## Token budget

The default budget is 200k characters (roughly 50k tokens). When conversation history exceeds this, older messages are dropped from the context sent to Claude. Identity, skills, and memory always fit — they're prioritized over old conversation turns.

## What Claude Code adds

On top of what ccgateway injects, Claude Code itself adds:
- `CLAUDE.md` from the workspace directory
- Tool definitions (based on `allowedTools` in agent config)
- Its own system prompt
