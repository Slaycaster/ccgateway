# `/talk` Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/talk <agentId>` Claude Code skill that spawns an isolated subagent session with a ccgateway agent's identity and skills injected, plus CLI commands to install/uninstall the skill.

**Architecture:** The skill is a markdown file (`SKILL.md`) that ships with the ccgateway npm package. A shared helper in `migrate.ts` copies it to `~/.claude/skills/ccgateway-talk/`. Three entry points call the helper: `ccg init`, `ccg migrate openclaw`, and `ccg install-skill`.

**Tech Stack:** TypeScript, Commander.js, Claude Code skill format (markdown with frontmatter)

---

### Task 1: Create the SKILL.md file

**Files:**
- Create: `skills/talk/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p skills/talk
```

- [ ] **Step 2: Write the SKILL.md file**

Create `skills/talk/SKILL.md` with the following content:

```markdown
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
```

- [ ] **Step 3: Verify the skill file has valid frontmatter**

```bash
head -4 skills/talk/SKILL.md
```

Expected output:
```
---
name: talk
description: Talk to a ccgateway agent directly from Claude Code. Spawns an isolated subagent session with the agent's full identity (CLAUDE.md, SOUL.md, IDENTITY.md, AGENTS.md) and ccgateway skills injected. Usage: /talk <agentId> <message>
---
```

- [ ] **Step 4: Commit**

```bash
git add skills/talk/SKILL.md
git commit -m "feat: add /talk skill for local agent sessions via Claude Code"
```

---

### Task 2: Add `skills` to package.json `files` array

**Files:**
- Modify: `package.json:31-35`

- [ ] **Step 1: Update the `files` array**

In `package.json`, change the `files` array from:
```json
"files": [
  "dist",
  "bin",
  "README.md"
],
```

to:
```json
"files": [
  "dist",
  "bin",
  "skills",
  "README.md"
],
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: include skills directory in npm package"
```

---

### Task 3: Add `installCcgSkill` and `uninstallCcgSkill` helpers to migrate.ts

**Files:**
- Modify: `src/migrate.ts`
- Test: `src/__tests__/migrate.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests at the end of `src/__tests__/migrate.test.ts`:

```typescript
// ── Skill install/uninstall ──────────────────────────────────────────────────

describe("installCcgSkill", () => {
  it("copies SKILL.md to ~/.claude/skills/ccgateway-talk/", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    await installCcgSkill();

    const skillPath = join(fakeClaudeHome, "skills", "ccgateway-talk", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const content = await readFile(skillPath, "utf-8");
    expect(content).toContain("name: talk");
    expect(content).toContain("ccgateway");

    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("overwrites existing skill file on reinstall", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    // Install twice — should not throw
    await installCcgSkill();
    await installCcgSkill();

    const skillPath = join(fakeClaudeHome, "skills", "ccgateway-talk", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    delete process.env.CLAUDE_CONFIG_DIR;
  });
});

describe("uninstallCcgSkill", () => {
  it("removes the ccgateway-talk skill directory", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    // Install first
    await installCcgSkill();
    const skillDir = join(fakeClaudeHome, "skills", "ccgateway-talk");
    expect(existsSync(skillDir)).toBe(true);

    // Uninstall
    await uninstallCcgSkill();
    expect(existsSync(skillDir)).toBe(false);

    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("does not throw when skill directory does not exist", async () => {
    const fakeClaudeHome = join(tempDir, ".claude");
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeHome;

    await expect(uninstallCcgSkill()).resolves.not.toThrow();

    delete process.env.CLAUDE_CONFIG_DIR;
  });
});
```

- [ ] **Step 2: Add the imports to the test file**

Add `installCcgSkill` and `uninstallCcgSkill` to the existing import from `"../migrate.js"`:

```typescript
import {
  migrateFromOpenClaw,
  stripModelPrefix,
  botTokenEnvVar,
  slackTokenEnvVars,
  deriveInstanceName,
  resolveCollisions,
  installCcgSkill,
  uninstallCcgSkill,
} from "../migrate.js";
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test -- --grep "installCcgSkill|uninstallCcgSkill"
```

Expected: FAIL — `installCcgSkill` and `uninstallCcgSkill` are not exported from migrate.ts

- [ ] **Step 4: Implement the helpers in migrate.ts**

Add the following at the end of `src/migrate.ts` (before any closing braces, after `initNew()`):

```typescript
// ── Claude Code skill install/uninstall ────────────────────────────────────

/**
 * Resolve the Claude Code config directory.
 * Uses CLAUDE_CONFIG_DIR env var if set, otherwise defaults to ~/.claude.
 */
function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Resolve the source path for the SKILL.md file shipped with ccgateway.
 * Works from both src/ (dev) and dist/ (installed).
 */
function getSkillSourcePath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Both src/ and dist/ are one level below package root
  return join(__dirname, '..', 'skills', 'talk', 'SKILL.md');
}

/**
 * Install the ccgateway /talk skill into Claude Code's skills directory.
 * Copies skills/talk/SKILL.md → ~/.claude/skills/ccgateway-talk/SKILL.md
 */
export async function installCcgSkill(): Promise<void> {
  const source = getSkillSourcePath();

  if (!existsSync(source)) {
    throw new Error(`Skill source not found: ${source}`);
  }

  const claudeHome = getClaudeConfigDir();
  const targetDir = join(claudeHome, 'skills', 'ccgateway-talk');
  const targetFile = join(targetDir, 'SKILL.md');

  await mkdir(targetDir, { recursive: true });
  await copyFile(source, targetFile);
}

/**
 * Remove the ccgateway /talk skill from Claude Code's skills directory.
 */
export async function uninstallCcgSkill(): Promise<void> {
  const claudeHome = getClaudeConfigDir();
  const targetDir = join(claudeHome, 'skills', 'ccgateway-talk');

  if (existsSync(targetDir)) {
    await rm(targetDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Add missing imports to migrate.ts**

Add `copyFile` and `rm` to the existing `node:fs/promises` import at the top of `src/migrate.ts`, and add `fileURLToPath` from `node:url`:

The existing imports at lines 1-5:
```typescript
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { glob } from 'node:fs/promises';
```

Change to:
```typescript
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- --grep "installCcgSkill|uninstallCcgSkill"
```

Expected: All 4 tests PASS

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: All tests pass (no regressions)

- [ ] **Step 8: Commit**

```bash
git add src/migrate.ts src/__tests__/migrate.test.ts
git commit -m "feat: add installCcgSkill/uninstallCcgSkill helpers"
```

---

### Task 4: Wire install into `ccg init` and `ccg migrate openclaw`

**Files:**
- Modify: `src/migrate.ts:440-446` (end of `migrateFromOpenClaw`)
- Modify: `src/migrate.ts:800-808` (end of `initNew`)

- [ ] **Step 1: Add skill install to `initNew()`**

In `src/migrate.ts`, at the end of `initNew()` (currently lines 800-808), add the skill install call before the "Next steps" output. Change:

```typescript
  console.log(`\nccgateway initialized at: ${process.env.CCG_HOME || join(homedir(), '.ccgateway')}`);
  console.log(`Agent "${agentId}" created with workspace: ${workspace}`);
  console.log('\nNext steps:');
  console.log('  ccg agents list     — see your agents');
  console.log('  ccg chat <agent>    — start a chat');
  console.log('  ccg start           — start the daemon');
}
```

to:

```typescript
  console.log(`\nccgateway initialized at: ${process.env.CCG_HOME || join(homedir(), '.ccgateway')}`);
  console.log(`Agent "${agentId}" created with workspace: ${workspace}`);

  // Install Claude Code /talk skill
  try {
    await installCcgSkill();
    console.log('Claude Code /talk skill installed.');
  } catch {
    console.log('Note: Could not install Claude Code /talk skill (run `ccg install-skill` manually).');
  }

  console.log('\nNext steps:');
  console.log('  ccg agents list     — see your agents');
  console.log('  ccg chat <agent>    — start a chat');
  console.log('  ccg start           — start the daemon');
}
```

- [ ] **Step 2: Add skill install to `migrateFromOpenClaw()`**

In `src/migrate.ts`, at the end of `migrateFromOpenClaw()` (currently lines 440-446), add the skill install call before the "Migration complete" message. Change:

```typescript
  console.log(`Config written to: ${join(home, 'config.json')}`);
  console.log();
  console.log('To start ccgateway, load the .env first:');
  console.log(`  source ${join(home, '.env')} && ccg start`);
  console.log();
  console.log('Migration complete.');
}
```

to:

```typescript
  console.log(`Config written to: ${join(home, 'config.json')}`);

  // Install Claude Code /talk skill
  try {
    await installCcgSkill();
    console.log('Claude Code /talk skill installed.');
  } catch {
    console.log('Note: Could not install Claude Code /talk skill (run `ccg install-skill` manually).');
  }

  console.log();
  console.log('To start ccgateway, load the .env first:');
  console.log(`  source ${join(home, '.env')} && ccg start`);
  console.log();
  console.log('Migration complete.');
}
```

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/migrate.ts
git commit -m "feat: install /talk skill during ccg init and migrate"
```

---

### Task 5: Add `ccg install-skill` and `ccg uninstall-skill` CLI commands

**Files:**
- Modify: `src/cli.ts:20-21` (imports)
- Modify: `src/cli.ts:663-666` (before `program.parse()`)

- [ ] **Step 1: Add import**

In `src/cli.ts`, change line 20:

```typescript
import { migrateFromOpenClaw, initNew } from "./migrate.js";
```

to:

```typescript
import { migrateFromOpenClaw, initNew, installCcgSkill, uninstallCcgSkill } from "./migrate.js";
```

- [ ] **Step 2: Add the CLI commands**

In `src/cli.ts`, before `program.parse();` (line 666), add:

```typescript
// ── install-skill / uninstall-skill ────────────────────────────────────────

program
  .command("install-skill")
  .description("Install the /talk skill into Claude Code (~/.claude/skills/)")
  .action(async () => {
    try {
      await installCcgSkill();
      console.log("Claude Code /talk skill installed to ~/.claude/skills/ccgateway-talk/");
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("uninstall-skill")
  .description("Remove the /talk skill from Claude Code")
  .action(async () => {
    try {
      await uninstallCcgSkill();
      console.log("Claude Code /talk skill removed.");
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 3: Verify the build compiles**

```bash
npm run lint
```

Expected: No TypeScript errors

- [ ] **Step 4: Test the commands manually**

```bash
# Install
npx tsx src/cli.ts install-skill
# Verify
ls ~/.claude/skills/ccgateway-talk/SKILL.md
# Uninstall
npx tsx src/cli.ts uninstall-skill
# Verify removed
ls ~/.claude/skills/ccgateway-talk/ 2>&1 || echo "removed"
```

Expected: Skill installs and uninstalls correctly

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add ccg install-skill and uninstall-skill commands"
```

---

### Task 6: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass

- [ ] **Step 2: Build the project**

```bash
npm run build
```

Expected: Clean build, no errors

- [ ] **Step 3: Test end-to-end with dev CLI**

```bash
# Install the skill
npx tsx src/cli.ts install-skill

# Verify it shows up in Claude Code
cat ~/.claude/skills/ccgateway-talk/SKILL.md | head -4
```

Expected output:
```
---
name: talk
description: Talk to a ccgateway agent directly from Claude Code...
---
```

- [ ] **Step 4: Clean up and uninstall**

```bash
npx tsx src/cli.ts uninstall-skill
```

- [ ] **Step 5: Final commit (if any fixes were needed)**

Only if previous steps required fixes. Otherwise skip.
