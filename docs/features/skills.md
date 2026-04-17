# Skills

Skills are markdown files with instructions that agents can read and follow. They're a way to give agents specialized knowledge without bloating their core identity files.

## Skill format

A skill is a markdown file with YAML frontmatter:

```markdown
---
name: deploy-to-staging
description: Steps for deploying the app to the staging environment
---

## Deployment Steps

1. Run tests: `npm test`
2. Build: `npm run build`
3. Deploy: `./scripts/deploy-staging.sh`
4. Verify: check https://staging.example.com
```

The `name` and `description` fields are required. The description is shown in the skill index so agents know what each skill does without loading the full content.

## Shared vs agent-specific

- **Shared skills** (`~/.ccgateway/skills/`) — Available to all agents
- **Agent-specific skills** (`~/.ccgateway/agents/{agentId}/skills/`) — Only available to that agent

Agent-specific skills override shared ones with the same name.

## Managing skills

```bash
# List all skills (shared + agent-specific)
ccg skills list [--agent <id>]

# Add a skill from a markdown file
ccg skills add deploy.md
ccg skills add navix-rca.md --agent salt

# Remove a skill
ccg skills remove deploy
ccg skills remove navix-rca --agent salt
```

You can also write skill files directly to the skills directory — the CLI is just a convenience.

## How agents use skills

On every invocation, ccgateway injects a skill index into the agent's context. This index lists each available skill's name and description. When a skill is relevant to the current task, the agent can read and follow it.

## Writing effective skills

- Keep skills focused on one task or domain
- Use the description to make the skill discoverable — agents decide whether to load a skill based on its description
- Include concrete steps, commands, and examples
- Don't duplicate information that's already in the agent's identity files
