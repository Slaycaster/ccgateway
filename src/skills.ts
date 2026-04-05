import { readFile, readdir, mkdir, copyFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  type: "markdown" | "native";
  filePath?: string; // for markdown skills
  agentId?: string; // if agent-specific
}

// ── Frontmatter parser ──────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown skill file.
 * Expects `---` delimiters at the top with `name:` and `description:` fields.
 * Simple parser — no yaml dependency.
 */
export function parseFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const lines = content.split("\n");

  // Must start with ---
  if (lines[0]?.trim() !== "---") return null;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) return null;

  let name = "";
  let description = "";

  for (let i = 1; i < endIndex; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) {
      name = nameMatch[1].trim();
      continue;
    }
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) {
      description = descMatch[1].trim();
      continue;
    }
  }

  if (!name) return null;

  return { name, description };
}

// ── SkillManager ────────────────────────────────────────────────────────────

export class SkillManager {
  private ccgHome: string;

  constructor(ccgHome: string) {
    this.ccgHome = ccgHome;
  }

  // ── Directory helpers ───────────────────────────────────────────────────

  private sharedSkillsDir(): string {
    return join(this.ccgHome, "skills");
  }

  private agentSkillsDir(agentId: string): string {
    return join(this.ccgHome, "agents", agentId, "skills");
  }

  // ── Core methods ────────────────────────────────────────────────────────

  /**
   * Discover all skills: shared + agent-specific.
   * Agent-specific skills override shared skills with the same name.
   */
  async discoverSkills(agentId?: string): Promise<SkillDefinition[]> {
    const skillMap = new Map<string, SkillDefinition>();

    // Load shared skills first
    const sharedSkills = await this.loadSkillsFromDir(this.sharedSkillsDir());
    for (const skill of sharedSkills) {
      skillMap.set(skill.name, skill);
    }

    // Load agent-specific skills (override shared)
    if (agentId) {
      const agentSkills = await this.loadSkillsFromDir(
        this.agentSkillsDir(agentId),
        agentId,
      );
      for (const skill of agentSkills) {
        skillMap.set(skill.name, skill);
      }
    }

    return Array.from(skillMap.values());
  }

  /**
   * Read a markdown skill's full content.
   * Checks agent-specific dir first (if agentId provided), then shared.
   */
  async readSkill(
    name: string,
    agentId?: string,
  ): Promise<string | null> {
    // Check agent-specific first
    if (agentId) {
      const agentPath = await this.findSkillFile(
        this.agentSkillsDir(agentId),
        name,
      );
      if (agentPath) {
        return readFile(agentPath, "utf-8");
      }
    }

    // Fall back to shared
    const sharedPath = await this.findSkillFile(this.sharedSkillsDir(), name);
    if (sharedPath) {
      return readFile(sharedPath, "utf-8");
    }

    return null;
  }

  /**
   * Build skill index for context injection (name + description per skill).
   */
  async buildSkillIndex(agentId?: string): Promise<string> {
    const skills = await this.discoverSkills(agentId);

    if (skills.length === 0) {
      return "--- Available Skills ---\n(none)";
    }

    const lines = skills.map((s) => {
      const tag = s.type === "native" ? " [native]" : "";
      return `- ${s.name}: ${s.description}${tag}`;
    });

    return `--- Available Skills ---\n${lines.join("\n")}`;
  }

  /**
   * Add a skill (copy .md file to shared or agent-specific directory).
   */
  async addSkill(filePath: string, agentId?: string): Promise<void> {
    const targetDir = agentId
      ? this.agentSkillsDir(agentId)
      : this.sharedSkillsDir();

    if (!existsSync(targetDir)) {
      await mkdir(targetDir, { recursive: true });
    }

    const fileName = basename(filePath);
    const targetPath = join(targetDir, fileName);
    await copyFile(filePath, targetPath);
  }

  /**
   * Remove a skill.
   */
  async removeSkill(name: string, agentId?: string): Promise<boolean> {
    const targetDir = agentId
      ? this.agentSkillsDir(agentId)
      : this.sharedSkillsDir();

    const filePath = await this.findSkillFile(targetDir, name);
    if (!filePath) return false;

    await unlink(filePath);
    return true;
  }

  /**
   * List skills.
   */
  async listSkills(agentId?: string): Promise<SkillDefinition[]> {
    return this.discoverSkills(agentId);
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Load all markdown skills from a directory.
   */
  private async loadSkillsFromDir(
    dir: string,
    agentId?: string,
  ): Promise<SkillDefinition[]> {
    if (!existsSync(dir)) return [];

    const entries = await readdir(dir);
    const skills: SkillDefinition[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const filePath = join(dir, entry);
      const content = await readFile(filePath, "utf-8");
      const meta = parseFrontmatter(content);

      if (meta) {
        const skill: SkillDefinition = {
          name: meta.name,
          description: meta.description,
          type: "markdown",
          filePath,
        };
        if (agentId) {
          skill.agentId = agentId;
        }
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * Find a skill file in a directory by skill name.
   * Reads frontmatter of each .md file to match by name.
   */
  private async findSkillFile(
    dir: string,
    name: string,
  ): Promise<string | null> {
    if (!existsSync(dir)) return null;

    const entries = await readdir(dir);

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const filePath = join(dir, entry);
      const content = await readFile(filePath, "utf-8");
      const meta = parseFrontmatter(content);

      if (meta && meta.name === name) {
        return filePath;
      }
    }

    return null;
  }
}
