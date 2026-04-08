---
name: talk
description: Talk to a ccgateway agent directly from Claude Code. Spawns an isolated subagent session with the agent's full identity (CLAUDE.md, SOUL.md, IDENTITY.md, AGENTS.md) and ccgateway skills injected. Usage: /talk <agentId> <message>
---

You are being invoked as the `/talk` skill for ccgateway. Your job is to spawn a subagent that assumes the identity of a ccgateway agent.

## Instructions

1. **Parse the argument.** The user invoked `/talk <agentId> <optional message>`. Extract the agent ID (first word) and the remaining text as the user's message/task.

2. **Read the ccgateway config.** Use the Read tool to read the config file. Try these paths in order:
   - `$CCG_HOME/config.json` (if CCG_HOME env var is set)
   - `~/.ccgateway/config.json` (default)

   If neither exists, tell the user: "No ccgateway config found. Run `ccg init` first."

3. **Find the agent.** Parse the JSON config and find the agent whose `id` matches the argument. If not found, list all available agent IDs from the config and ask the user to pick one. Stop here until they respond.

4. **Read identity files.** From the agent's `workspace` directory, read these files (skip any that don't exist):
   - `CLAUDE.md`
   - `SOUL.md`
   - `IDENTITY.md`
   - `AGENTS.md`

   Concatenate the contents of all files that exist, separated by a blank line. This is the agent's **identity block**.

5. **Read ccgateway skills.** Read all `.md` files from these directories (skip directories that don't exist):
   - `~/.ccgateway/skills/` (shared skills)
   - `~/.ccgateway/agents/<agentId>/skills/` (agent-specific skills, override shared skills with the same name)

   For each `.md` file: strip the YAML frontmatter (everything between the opening `---` and closing `---`), keep the body. This is the **skills block**.

6. **Spawn the subagent.** Use the Agent tool with:
   - **prompt:** Compose as follows:
     ```
     You are <agent name>. Below is your identity and skills. Follow them exactly.

     === IDENTITY ===
     <identity block from step 4>

     === SKILLS ===
     <skills block from step 5>

     === TASK ===
     <the user's message/task from step 1>
     ```
   - **description:** `Talk to <agent name>`

   The subagent will work in the agent's workspace directory. Include the workspace path in the prompt:
   `Your working directory is: <agent.workspace>`

7. **Return the result.** Relay the subagent's response back to the user.
