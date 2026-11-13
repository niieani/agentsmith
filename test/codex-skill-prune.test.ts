import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commitAll, projectFixture, put, skillMd } from "./support/project.ts";

test("removing a skill from a Codex-only scope deletes its whole .codex/skills directory", async () => {
  const f = await projectFixture("agentsmith-codex-prune-");
  await put(join(f.config, "config.toml"), ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'packs = ["team"]', ""].join("\n"));
  await put(join(f.config, "packs", "team", "pack.toml"), 'skills = ["team-skill"]\n');
  await put(join(f.config, "skills", "team-skill", "SKILL.md"), skillMd("team-skill"));
  await put(join(f.project, ".gitignore"), "/.codex/skills/*\n");
  await commitAll(f, "fixture");
  const first = await f.asmith("project", "generate");
  expect(first.exitCode, first.stderr).toBe(0);
  expect(existsSync(join(f.project, ".codex", "skills", "team-skill", "SKILL.md"))).toBeTrue();

  await put(join(f.config, "packs", "team", "pack.toml"), "skills = []\n");
  const second = await f.asmith("project", "generate");
  expect(second.exitCode, second.stderr).toBe(0);
  expect(existsSync(join(f.project, ".codex", "skills", "team-skill"))).toBeFalse();
});
