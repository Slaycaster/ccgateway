# Migrating from OpenClaw

If you're coming from OpenClaw, ccgateway can automatically convert your existing configuration.

## Quick migration

```bash
ccg migrate openclaw
```

This auto-discovers OpenClaw configs at `~/.openclaw*/openclaw.json` and converts them.

## What gets migrated

- **Agents** — Agent list with names, models, and workspaces
- **Channel bindings** — Discord and Slack channel mappings
- **Bot tokens** — Written to `~/.ccgateway/.env`
- **Heartbeats** — Cron jobs converted to ccgateway heartbeat format

## Options

```bash
# Specify config paths explicitly
ccg migrate openclaw --config ~/.openclaw/openclaw.json --config ~/.openclaw-other/openclaw.json

# Preview without writing
ccg migrate openclaw --dry-run
```

## After migration

1. Review `~/.ccgateway/config.json` — make sure agents and bindings look correct
2. Check `~/.ccgateway/.env` — verify bot tokens
3. Test with `ccg agents list` and `ccg chat <agent>`
4. Start the daemon: `source ~/.ccgateway/.env && ccg start`

Both systems can coexist — migrating doesn't affect your OpenClaw installation.
