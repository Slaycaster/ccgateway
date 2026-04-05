import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillManager, parseFrontmatter } from "../skills.js";

// ── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccg-skills-test-"));
  // Create standard directory structure
  await mkdir(join(tempDir, "skills"), { recursive: true });
  await mkdir(join(tempDir, "agents"), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Helper ──────────────────────────────────────────────────────────────────

function makeSkillContent(name: string, description: string, body = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

// ── parseFrontmatter ────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("extracts name and description from valid frontmatter", () => {
    const content = makeSkillContent("create-pr", "Create a pull request");
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      name: "create-pr",
      description: "Create a pull request",
    });
  });

  it("returns null when no frontmatter delimiters", () => {
    expect(parseFrontmatter("# Just a heading\nSome text.")).toBeNull();
  });

  it("returns null when opening delimiter is missing", () => {
    expect(parseFrontmatter("name: foo\n---\n")).toBeNull();
  });

  it("returns null when closing delimiter is missing", () => {
    expect(parseFrontmatter("---\nname: foo\n")).toBeNull();
  });

  it("returns null when name field is missing", () => {
    const content = "---\ndescription: Some desc\n---\n";
    expect(parseFrontmatter(content)).toBeNull();
  });

  it("handles description being empty string", () => {
    const content = "---\nname: my-skill\ndescription: \n---\n";
    // description is empty so the regex won't match (.+ needs at least one char)
    // name is still present
    const result = parseFrontmatter(content);
    expect(result).toEqual({ name: "my-skill", description: "" });
  });

  it("trims whitespace from values", () => {
    const content = "---\nname:   padded-skill   \ndescription:   Padded desc   \n---\n";
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      name: "padded-skill",
      description: "Padded desc",
    });
  });
});

// ── discoverSkills ──────────────────────────────────────────────────────────

describe("discoverSkills", () => {
  it("finds markdown files in shared dir", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(
      join(tempDir, "skills", "create-pr.md"),
      makeSkillContent("create-pr", "Create a pull request"),
    );
    await writeFile(
      join(tempDir, "skills", "run-tests.md"),
      makeSkillContent("run-tests", "Run test suite"),
    );

    const skills = await mgr.discoverSkills();
    expect(skills).toHaveLength(2);

    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["create-pr", "run-tests"]);

    for (const s of skills) {
      expect(s.type).toBe("markdown");
      expect(s.agentId).toBeUndefined();
    }
  });

  it("finds agent-specific skills", async () => {
    const mgr = new SkillManager(tempDir);
    const agentDir = join(tempDir, "agents", "agent-1", "skills");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "deploy.md"),
      makeSkillContent("deploy", "Deploy the app"),
    );

    const skills = await mgr.discoverSkills("agent-1");
    const agentSkill = skills.find((s) => s.name === "deploy");
    expect(agentSkill).toBeDefined();
    expect(agentSkill!.agentId).toBe("agent-1");
  });

  it("agent-specific skills override shared skills with same name", async () => {
    const mgr = new SkillManager(tempDir);

    // Shared skill
    await writeFile(
      join(tempDir, "skills", "create-pr.md"),
      makeSkillContent("create-pr", "Shared version"),
    );

    // Agent-specific skill with same name
    const agentDir = join(tempDir, "agents", "agent-1", "skills");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "create-pr.md"),
      makeSkillContent("create-pr", "Agent-specific version"),
    );

    const skills = await mgr.discoverSkills("agent-1");
    const prSkill = skills.find((s) => s.name === "create-pr");
    expect(prSkill).toBeDefined();
    expect(prSkill!.description).toBe("Agent-specific version");
    expect(prSkill!.agentId).toBe("agent-1");

    // Should only appear once
    const prSkills = skills.filter((s) => s.name === "create-pr");
    expect(prSkills).toHaveLength(1);
  });

  it("ignores non-.md files", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(join(tempDir, "skills", "readme.txt"), "Not a skill");
    await writeFile(
      join(tempDir, "skills", "real-skill.md"),
      makeSkillContent("real-skill", "A real skill"),
    );

    const skills = await mgr.discoverSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("real-skill");
  });

  it("ignores .md files without valid frontmatter", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(
      join(tempDir, "skills", "no-frontmatter.md"),
      "# No frontmatter\nJust content.",
    );

    const skills = await mgr.discoverSkills();
    expect(skills).toHaveLength(0);
  });

  it("returns empty array when directory does not exist", async () => {
    const mgr = new SkillManager(join(tempDir, "nonexistent"));
    const skills = await mgr.discoverSkills();
    expect(skills).toEqual([]);
  });
});

// ── readSkill ───────────────────────────────────────────────────────────────

describe("readSkill", () => {
  it("returns file content for existing skill", async () => {
    const mgr = new SkillManager(tempDir);
    const content = makeSkillContent("create-pr", "Create a PR", "Do the thing.");
    await writeFile(join(tempDir, "skills", "create-pr.md"), content);

    const result = await mgr.readSkill("create-pr");
    expect(result).toBe(content);
  });

  it("returns null for non-existent skill", async () => {
    const mgr = new SkillManager(tempDir);
    const result = await mgr.readSkill("nonexistent");
    expect(result).toBeNull();
  });

  it("prefers agent-specific skill over shared", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(
      join(tempDir, "skills", "create-pr.md"),
      makeSkillContent("create-pr", "Shared", "Shared content"),
    );
    const agentDir = join(tempDir, "agents", "agent-1", "skills");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "create-pr.md"),
      makeSkillContent("create-pr", "Agent", "Agent content"),
    );

    const result = await mgr.readSkill("create-pr", "agent-1");
    expect(result).toContain("Agent content");
  });

  it("falls back to shared when agent-specific not found", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(
      join(tempDir, "skills", "create-pr.md"),
      makeSkillContent("create-pr", "Shared", "Shared content"),
    );

    const result = await mgr.readSkill("create-pr", "agent-1");
    expect(result).toContain("Shared content");
  });
});

// ── buildSkillIndex ─────────────────────────────────────────────────────────

describe("buildSkillIndex", () => {
  it("formats correctly with available skills", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(
      join(tempDir, "skills", "create-pr.md"),
      makeSkillContent("create-pr", "Create a pull request with conventional format"),
    );
    await writeFile(
      join(tempDir, "skills", "run-tests.md"),
      makeSkillContent("run-tests", "Run test suite and report results"),
    );

    const index = await mgr.buildSkillIndex();
    expect(index).toContain("--- Available Skills ---");
    expect(index).toContain("- create-pr: Create a pull request with conventional format");
    expect(index).toContain("- run-tests: Run test suite and report results");
  });

  it("shows (none) when no skills exist", async () => {
    const mgr = new SkillManager(tempDir);
    const index = await mgr.buildSkillIndex();
    expect(index).toContain("--- Available Skills ---");
    expect(index).toContain("(none)");
  });
});

// ── addSkill ────────────────────────────────────────────────────────────────

describe("addSkill", () => {
  it("copies file to shared skills directory", async () => {
    const mgr = new SkillManager(tempDir);
    const sourceFile = join(tempDir, "source-skill.md");
    const content = makeSkillContent("new-skill", "A new skill");
    await writeFile(sourceFile, content);

    await mgr.addSkill(sourceFile);

    const targetPath = join(tempDir, "skills", "source-skill.md");
    expect(existsSync(targetPath)).toBe(true);
    const copied = await readFile(targetPath, "utf-8");
    expect(copied).toBe(content);
  });

  it("copies file to agent-specific skills directory", async () => {
    const mgr = new SkillManager(tempDir);
    const sourceFile = join(tempDir, "agent-skill.md");
    await writeFile(sourceFile, makeSkillContent("agent-skill", "For agent"));

    await mgr.addSkill(sourceFile, "agent-1");

    const targetPath = join(
      tempDir,
      "agents",
      "agent-1",
      "skills",
      "agent-skill.md",
    );
    expect(existsSync(targetPath)).toBe(true);
  });

  it("creates target directory if it does not exist", async () => {
    const mgr = new SkillManager(tempDir);
    // Remove the skills dir to test creation
    await rm(join(tempDir, "skills"), { recursive: true, force: true });

    const sourceFile = join(tempDir, "skill.md");
    await writeFile(sourceFile, makeSkillContent("skill", "A skill"));

    await mgr.addSkill(sourceFile);
    expect(existsSync(join(tempDir, "skills", "skill.md"))).toBe(true);
  });
});

// ── removeSkill ─────────────────────────────────────────────────────────────

describe("removeSkill", () => {
  it("removes existing skill and returns true", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(
      join(tempDir, "skills", "to-remove.md"),
      makeSkillContent("to-remove", "Will be removed"),
    );

    const result = await mgr.removeSkill("to-remove");
    expect(result).toBe(true);
    expect(existsSync(join(tempDir, "skills", "to-remove.md"))).toBe(false);
  });

  it("returns false for non-existent skill", async () => {
    const mgr = new SkillManager(tempDir);
    const result = await mgr.removeSkill("nonexistent");
    expect(result).toBe(false);
  });

  it("removes agent-specific skill", async () => {
    const mgr = new SkillManager(tempDir);
    const agentDir = join(tempDir, "agents", "agent-1", "skills");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "agent-skill.md"),
      makeSkillContent("agent-skill", "Agent skill"),
    );

    const result = await mgr.removeSkill("agent-skill", "agent-1");
    expect(result).toBe(true);
    expect(existsSync(join(agentDir, "agent-skill.md"))).toBe(false);
  });
});

// ── listSkills ──────────────────────────────────────────────────────────────

describe("listSkills", () => {
  it("delegates to discoverSkills", async () => {
    const mgr = new SkillManager(tempDir);
    await writeFile(
      join(tempDir, "skills", "skill-a.md"),
      makeSkillContent("skill-a", "Skill A"),
    );

    const listed = await mgr.listSkills();
    const discovered = await mgr.discoverSkills();
    expect(listed).toEqual(discovered);
  });
});
