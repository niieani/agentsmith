import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, projectFixture, put, skillMd } from "./support/project.ts";

async function ignoredSkillsFixture() {
  const f = await projectFixture("agentsmith-ownership-");
  await put(join(f.config, "config.toml"), ['harnesses = ["claude"]', "", "[[scopes]]", 'path = "."', 'packs = ["local"]', ""].join("\n"));
  await put(join(f.config, "packs", "local", "pack.toml"), 'skills = ["review", "deploy"]\n');
  await put(join(f.config, "skills", "review", "SKILL.md"), skillMd("review"));
  await put(join(f.config, "skills", "deploy", "SKILL.md"), skillMd("deploy"));
  await put(join(f.project, ".gitignore"), "/.claude/skills/*\n!/.claude/skills/.gitkeep\n");
  await put(join(f.project, ".claude", "skills", ".gitkeep"), "");
  await commitAll(f, "fixture");
  return f;
}

describe("project ownership of untracked artifacts", () => {
  test("regenerates ignored skills, deletes a removed one, and refuses a hand-edited one", async () => {
    const f = await ignoredSkillsFixture();
    const first = await f.asmith("project", "generate");
    expect(first.exitCode, first.stderr).toBe(0);
    const deploy = join(f.project, ".claude", "skills", "deploy", "SKILL.md");
    expect(await readFile(deploy, "utf8")).toBe(skillMd("deploy"));
    expect(await f.git("status", "--porcelain")).toBe("");
    const state = await readFile(join(f.project, ".git", "agentsmith", "state.toml"), "utf8");
    expect(state).toContain('".claude/skills/deploy/SKILL.md" = "');

    // Regenerating over ignored output that nobody edited succeeds.
    await put(join(f.config, "skills", "review", "SKILL.md"), skillMd("review", "Changed."));
    const second = await f.asmith("project", "generate");
    expect(second.exitCode, second.stderr).toBe(0);
    expect(await readFile(join(f.project, ".claude", "skills", "review", "SKILL.md"), "utf8")).toContain("Changed.");

    // Removing a skill from the configuration deletes its ignored directory.
    await put(join(f.config, "packs", "local", "pack.toml"), 'skills = ["review"]\n');
    const removed = await f.asmith("project", "generate");
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(existsSync(join(f.project, ".claude", "skills", "deploy"))).toBeFalse();
    expect(existsSync(join(f.project, ".claude", "skills", ".gitkeep"))).toBeTrue();

    // A hand edit blocks deletion, and the edited file survives.
    await writeFile(join(f.project, ".claude", "skills", "review", "SKILL.md"), "mine\n");
    await put(join(f.config, "packs", "local", "pack.toml"), "skills = []\n");
    const refused = await f.asmith("project", "generate");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("Refusing to delete ignored and edited stale project artifact");
    expect(await readFile(join(f.project, ".claude", "skills", "review", "SKILL.md"), "utf8")).toBe("mine\n");
  });

  test("a generated skill named like a committed skill it does not own is an error naming that path", async () => {
    const f = await ignoredSkillsFixture();
    await put(join(f.project, ".gitignore"), "");
    await put(join(f.project, ".claude", "skills", "review", "SKILL.md"), skillMd("review", "Written by the authors."));
    await commitAll(f, "authors' skill");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(join(f.project, ".claude", "skills", "review"));
    expect(result.stderr).toContain("Rename the generated skill");
    expect(await readFile(join(f.project, ".claude", "skills", "review", "SKILL.md"), "utf8")).toContain("Written by the authors.");
  });
});
