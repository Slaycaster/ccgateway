# Multi-instance, Multi-gateway OpenClaw Migration

## Problem

`ccg migrate openclaw` only handles Discord-based OpenClaw configs. It crashes on Slack bindings (missing `peer` property) and cannot merge multiple OpenClaw instances into one ccgateway config. Real-world deployments (e.g., FPJ + Sentri) run multiple OpenClaw instances with Slack as the primary gateway.

## Goals

1. Support Slack token extraction and `slack-gateway` plugin generation
2. Auto-discover and merge multiple OpenClaw instances
3. Handle both Slack token layouts (multi-bot accounts and top-level single bot)
4. Resolve agent ID collisions across instances
5. Synthesize agents for instances that have no `agents.list`

## Non-goals

- Interactive prompts during migration (must stay `--dry-run` compatible)
- Converting `kind: "every"` interval jobs to cron expressions
- Migrating webhook hooks, skill configs, or gateway auth settings

---

## Instance Discovery

### Auto-discovery (default)

Glob `~/.openclaw*/openclaw.json`. Each match is one instance. Instance name is derived from the directory:

- `~/.openclaw/openclaw.json` → instance name `openclaw`
- `~/.openclaw-sentri/openclaw.json` → instance name `sentri`

### Explicit override

`--config path1 --config path2` disables auto-discovery entirely. Instance name derived from the parent directory of each path using the same stripping logic (remove leading `.` and `openclaw` prefix).

Single `--config path` works as before — one instance, no discovery.

---

## Agent Handling

### Extraction

- Instances with `agents.list` → extract agents as today (model, workspace, identity, etc.).
- Instances with **no `agents.list`** → synthesize one agent:
  - `id`: instance name (e.g., `sentri`)
  - `name`: instance name
  - `model`: from `agents.defaults.model.primary` or fallback `claude-sonnet-4-6`
  - `workspace`: from `agents.defaults.workspace` or `$HOME`
  - `maxConcurrentSessions`: from `agents.defaults.maxConcurrent` or `4`

### ID Collision Resolution

Applied after all instances are collected. Only rename when there's an actual collision:

- If two instances both define agent `main`, prefix with instance name: `openclaw-main`, `sentri-main`.
- Unique IDs stay untouched (e.g., `vilma` remains `vilma`).
- The migration summary shows any renames performed.
- Bindings, heartbeats, and bot→agent mappings use the renamed IDs.

---

## Slack Token Extraction

Two OpenClaw patterns exist in the wild:

### Pattern 1: Multi-bot accounts

```json
{
  "channels": {
    "slack": {
      "accounts": {
        "default": { "botToken": "xoxb-...", "appToken": "xapp-..." },
        "vilma": { "botToken": "xoxb-...", "appToken": "xapp-..." }
      }
    }
  }
}
```

Each account becomes a bot entry. Env vars:
- `SLACK_{NAME}_TOKEN` → botToken
- `SLACK_{NAME}_APP_TOKEN` → appToken

### Pattern 2: Top-level single bot

```json
{
  "channels": {
    "slack": {
      "botToken": "xoxb-...",
      "appToken": "xapp-..."
    }
  }
}
```

Single bot named after the instance. Env vars:
- `SLACK_{INSTANCE}_TOKEN`
- `SLACK_{INSTANCE}_APP_TOKEN`

### signingSecret

Made optional in the `SlackBotConfig` interface in `slack-gateway.ts`. Socket mode doesn't use it — authentication is via `appToken`. Migration omits it.

---

## Binding Extraction

Three sources, processed in order with deduplication via a `seen` set:

1. **Explicit `bindings[]`** — existing logic with `peer?.id ?? '*'` fix for Slack bindings without a peer.
2. **Slack account structure** (`channels.slack.accounts.{bot}`) — for each account that maps to an agent (via explicit bindings or bot→agent inference), create a `gateway: 'slack'` binding with `channel: '*'` (Slack routing is bot-level, not per-channel like Discord).
3. **Discord channel structure** (`channels.discord.accounts.{bot}.guilds.{guild}.channels`) — unchanged from current behavior.

Bindings reference the post-collision-resolution agent IDs.

---

## Plugin Generation

### Slack

If any Slack bots were found across all instances, create one `slack-gateway` plugin:

```json
{
  "name": "slack-gateway",
  "enabled": true,
  "config": {
    "bots": {
      "default": { "token": "$SLACK_DEFAULT_TOKEN", "appToken": "$SLACK_DEFAULT_APP_TOKEN" },
      "vilma": { "token": "$SLACK_VILMA_TOKEN", "appToken": "$SLACK_VILMA_APP_TOKEN" },
      "sentri": { "token": "$SLACK_SENTRI_TOKEN", "appToken": "$SLACK_SENTRI_APP_TOKEN" }
    },
    "workspace": "",
    "allowedUsers": ["U09QC6LF7FC"],
    "commands": ["/new", "/reset", "/status"]
  }
}
```

### Discord

Unchanged from current behavior. If any Discord bots found, create one `discord-gateway` plugin.

Both plugins can coexist in the same config.

---

## Heartbeats

- Extract `kind: "cron"` jobs from each instance's `cron/jobs.json` — unchanged.
- Skip `kind: "every"` interval jobs silently.
- Heartbeat `agent` fields use post-collision-resolution agent IDs.

---

## .env Generation

All tokens across all instances and gateways go into a single `.env` file:

```bash
export SLACK_DEFAULT_TOKEN=xoxb-...
export SLACK_DEFAULT_APP_TOKEN=xapp-...
export SLACK_VILMA_TOKEN=xoxb-...
export SLACK_VILMA_APP_TOKEN=xapp-...
export SLACK_SENTRI_TOKEN=xoxb-...
export SLACK_SENTRI_APP_TOKEN=xapp-...
export DISCORD_GINGER_TOKEN=...
```

Bot names in env vars follow the post-collision-resolution names if any renaming occurred.

---

## CLI Interface

```
ccg migrate openclaw [--config <path>...] [--dry-run]
```

No new flags beyond making `--config` repeatable.

---

## Merging Rules

1. Collect all instances (auto-discovered or explicit).
2. Extract agents from each instance.
3. Resolve agent ID collisions across all instances.
4. Extract bindings, tokens, heartbeats from each instance (using resolved agent IDs).
5. Concatenate all arrays. Deduplicate bindings by `gateway:channel:bot` key.
6. Build plugin entries (one per gateway type that has bots).
7. Output single merged config.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/migrate.ts` | Major: refactor to multi-instance, add Slack extraction, collision resolution |
| `src/plugins/slack-gateway.ts` | Minor: make `signingSecret` optional in `SlackBotConfig` |
| `src/cli.ts` | Minor: make `--config` repeatable |
| `src/__tests__/migrate.test.ts` | Add tests for Slack extraction, multi-instance, collisions, synthesized agents |
| `src/migrate.ts` interfaces | Update `OpenClawConfig` to model `channels.slack` structure |
