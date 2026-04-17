# Memory

Memory in ccgateway is file-based. Agents store their memories as markdown files in their workspace, and ccgateway injects recent context into every turn.

## How it works

Each agent's workspace has a memory directory:

```
~/clawd-salt/
├── MEMORY.md          # Curated long-term memory
└── memory/
    ├── 2026-04-10.md  # Today's daily log
    └── 2026-04-09.md  # Yesterday's daily log
```

On every invocation, ccgateway reads and injects:
- **Today's daily log** — What's happened so far today
- **Yesterday's daily log** — Recent context from the previous day

`MEMORY.md` can also be injected depending on the session type (e.g., main sessions vs. shared contexts).

## Daily logs

Daily logs are raw notes agents write throughout the day. They capture decisions, context, and events as they happen.

Agents are instructed to create and append to `memory/YYYY-MM-DD.md` during their sessions. ccgateway handles injecting the right files — agents just need to write.

## Long-term memory (MEMORY.md)

`MEMORY.md` is the agent's curated long-term memory. Over time, agents review their daily logs and distill important information into this file.

This separation means:
- Daily logs capture everything (raw, unfiltered)
- MEMORY.md keeps only what matters (curated, organized)

## Memory is context, not storage

Memory injection adds to the system prompt on every turn. This means it uses token budget. Keep memory files focused and trim — excessively large memory files eat into the space available for conversation history.
