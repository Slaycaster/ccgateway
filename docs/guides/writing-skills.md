# Writing Skills

How to write effective skill files for your agents.

## Structure

Every skill is a markdown file with YAML frontmatter:

```markdown
---
name: skill-name
description: One-line description of what this skill does
---

## Instructions

Your skill content here.
```

### Required fields

- **name** — Unique identifier (kebab-case recommended)
- **description** — One line, shown in the skill index. This is how agents decide whether to load the skill, so make it specific.

## Best practices

### Be specific in descriptions

```markdown
# Bad
description: Helps with deployment

# Good
description: Steps for deploying the NailStory app to production via Vercel, including pre-deploy checks
```

### One skill, one job

Don't create monolithic skills. A skill for "deployment" and a skill for "database migrations" are better than one skill for "deployment and migrations."

### Include concrete examples

```markdown
## Checking build status

Run:
\`\`\`bash
vercel --prod --dry-run
\`\`\`

Expected output when ready:
\`\`\`
✅ Build ready for deployment
\`\`\`
```

### Use conditional logic

```markdown
## Handling errors

If the deploy fails with `FUNCTION_INVOCATION_TIMEOUT`:
1. Check the function logs: `vercel logs --follow`
2. Look for cold start issues
3. Consider increasing the timeout in `vercel.json`

If the deploy fails with `BUILD_FAILED`:
1. Run `npm run build` locally first
2. Check for missing environment variables
```

## Shared vs agent-specific

Place skills based on who needs them:

- `~/.ccgateway/skills/` — Skills all agents might use (e.g., `cross-agent-comms.md`)
- `~/.ccgateway/agents/{id}/skills/` — Skills for one agent (e.g., `navix-rca.md` for Salt)

Agent-specific skills override shared ones with the same name.

## Installing skills

```bash
# Shared
ccg skills add my-skill.md

# Agent-specific
ccg skills add my-skill.md --agent salt
```

Or just copy the file directly to the skills directory.
