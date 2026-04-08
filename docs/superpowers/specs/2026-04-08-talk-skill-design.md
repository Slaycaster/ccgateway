# `/talk` Skill — Local Agent Sessions via Claude Code

**Date:** 2026-04-08
**Status:** Approved

## Problem

ccgateway agents are only reachable through Discord/Slack gateways or the basic `ccg chat` REPL. When working on multiple tickets across worktrees simultaneously, a single Discord channel per agent becomes a bottleneck — conversations from different workstreams interleave and context gets confused.

Creating duplicate agents (salt1, salt2) in separate channels is a workaround, not a solution.

## Solution

A Claude Code skill (`/talk <agentId>`) that spawns an isolated subagent session with the target agent's full identity and ccgateway skills injected. No gateway, no daemon, no JSONL persistence — just the agent's personality running in Claude Code's subagent system.

## Usage

```
/talk salt Fix the failing test in auth.spec.ts
/talk salt Review the PR on branch feature/auth
```

## How It Works

1. User invokes `/talk salt` (with a message/task) in Claude Code
2. Skill instructs Claude Code to read `~/.ccgateway/config.json` (or `$CCG_HOME/config.json`)
3. Find the agent by ID — if not found, list available agents
4. Read identity files from the agent's workspace: CLAUDE.md, SOUL.md, IDENTITY.md, AGENTS.md (whichever exist)
5. Read ccgateway skills for the agent — load all `.md` skill files from `~/.ccgateway/skills/` (shared) and `~/.ccgateway/agents/{agentId}/skills/` (agent-specific). All shared skills are available to all agents; agent-specific skills override shared ones with the same name
6. Spawn a Claude Code subagent with:
   - Identity content as preamble
   - Skills index appended
   - User's message/task forwarded
   - Working directory set to the agent's workspace
   - Model inherited from parent session

## Session Characteristics

- **Ephemeral** — no JSONL persistence, no session key, no history carry-over
- **Daemon-independent** — does not require `ccg start` or any running process
- **Isolated** — subagent has its own context window, does not pollute the parent session
- **Parallel-safe** — multiple `/talk` invocations can run in separate terminal tabs simultaneously

## Installation

The skill ships as `skills/talk/SKILL.md` in the ccgateway npm package. It gets installed to `~/.claude/skills/ccgateway-talk/SKILL.md`.

### Install paths

Three commands install the skill:

1. **`ccg init`** — new setups, calls `installCcgSkill()` at the end
2. **`ccg migrate openclaw`** — migrations, calls `installCcgSkill()` at the end
3. **`ccg install-skill`** — standalone command for existing installations

One command removes it:

4. **`ccg uninstall-skill`** — removes `~/.claude/skills/ccgateway-talk/`

### Install logic

A shared helper function handles the copy:

```typescript
// Shared helper — used by init, migrate, and install-skill commands
async function installCcgSkill(): Promise<void> {
  // 1. Resolve source: <package-root>/skills/talk/SKILL.md
  // 2. Resolve target: ~/.claude/skills/ccgateway-talk/SKILL.md
  // 3. Create target directory if needed
  // 4. Copy SKILL.md to target
  // 5. Log success
}

async function uninstallCcgSkill(): Promise<void> {
  // 1. Resolve target: ~/.claude/skills/ccgateway-talk/
  // 2. Remove directory recursively if exists
  // 3. Log success
}
```

## Skill File Content

The `SKILL.md` file instructs Claude Code to:

1. Read ccgateway config from `~/.ccgateway/config.json` (falling back to `$CCG_HOME`)
2. Validate the agent ID from the argument — if invalid, list agents and ask user to pick
3. Read identity files (CLAUDE.md, SOUL.md, IDENTITY.md, AGENTS.md) from `agent.workspace`
4. Read ccgateway skills: iterate all `.md` files in `~/.ccgateway/skills/` (shared) and `~/.ccgateway/agents/{agentId}/skills/` (agent-specific), strip frontmatter, include full content. Agent-specific skills override shared skills with the same name
5. Compose a subagent prompt with identity + skills as preamble, user's task as the instruction
6. Spawn the subagent via the Agent tool, with working directory set to `agent.workspace`

The skill reads files directly using Claude Code's Read tool and spawns via the Agent tool — no shell commands needed for the core flow.

## File Layout

```
/home/fdenimar/Code/ccgateway/
├── skills/
│   └── talk/
│       └── SKILL.md              <- NEW: the skill file (ships with package)
├── src/
│   ├── cli.ts                    <- MODIFIED: add install-skill / uninstall-skill commands
│   └── migrate.ts                <- MODIFIED: call installCcgSkill() in initNew() and migrateFromOpenClaw()
```

Installed to:
```
~/.claude/skills/ccgateway-talk/SKILL.md
```

## Code Changes Summary

| File | Change |
|------|--------|
| `skills/talk/SKILL.md` | New file — the Claude Code skill |
| `src/migrate.ts` | Add `installCcgSkill()` and `uninstallCcgSkill()` helper functions. Call `installCcgSkill()` at end of `initNew()` and `migrateFromOpenClaw()` |
| `src/cli.ts` | Add `ccg install-skill` and `ccg uninstall-skill` commands that call the helpers |

## Out of Scope

- Session persistence (JSONL) — ephemeral by design
- Workspace override flag — agent config is authoritative
- ccgateway daemon interaction — skill is standalone
- Cross-agent messaging from within `/talk` sessions
- Model override — inherits from parent Claude Code session
