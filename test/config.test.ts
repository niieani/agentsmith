import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  discoverProjectConfig,
  loadMachineConfig,
  loadPackConfig,
  loadProfileConfig,
  loadProjectConfig,
  loadRootConfig,
  parseSourceId,
  projectConfigPath,
  projectSourceRoot,
  resolveConfiguredPath,
  resolveSourceDir,
  sourceRootConfigPath,
} from "../src/config.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agentsmith-config-"));
  roots.push(root);
  return root;
}

function file(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function sourceFixture(): string {
  const root = temp();
  file(sourceRootConfigPath(root), `version = 1\n[budgets]\ninstruction_layer_bytes = 100\n`);
  mkdirSync(join(root, "templates/personal"), { recursive: true });
  file(join(root, "templates/personal/default.md"), "hello\n");
  mkdirSync(join(root, "packs/base"), { recursive: true });
  file(join(root, "packs/base/pack.toml"), "version = 1\nskills = [\"review\"]\n");
  mkdirSync(join(root, "skills/review"), { recursive: true });
  file(join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
  file(join(root, "profiles/studio.toml"), `version = 1\nharnesses = [\"codex\", \"claude-code\"]\ntemplate = \"personal\"\npacks = [\"base\"]\nskills_enable = [\"review\"]\nskills_disable = []\n[budgets]\neffective_instruction_bytes = 200\n`);
  return root;
}

describe("Source IDs and paths", () => {
  test("parses source and project IDs", () => {
    expect(parseSourceId("software/default")).toEqual({ owner: "source", name: "software/default", raw: "software/default" });
    expect(parseSourceId("@project/release")).toEqual({ owner: "project", name: "release", raw: "@project/release" });
  });

  test.each(["", "/absolute", "../escape", "a//b", "a/./b", "a/../b", "a\\b", "@other/x", "a\0b"])(
    "rejects invalid Source ID %p",
    (value) => expect(() => parseSourceId(value)).toThrow(ConfigError),
  );

  test("resolves source ownership without fallback", () => {
    const source = sourceFixture();
    const project = temp();
    mkdirSync(join(projectSourceRoot(project), "skills/local"), { recursive: true });
    expect(resolveSourceDir("review", "skill", source, project)).toBe(join(source, "skills/review"));
    expect(resolveSourceDir("@project/local", "skill", source, project)).toBe(join(project, ".config/agentsmith/skills/local"));
    expect(() => resolveSourceDir("@project/review", "skill", source, project)).toThrow(/missing skill source/);
  });

  test("rejects symlink sources", () => {
    const source = sourceFixture();
    symlinkSync(join(source, "skills/review"), join(source, "skills/link"));
    expect(() => resolveSourceDir("link", "skill", source)).toThrow(/symlink/);
    const outside = temp();
    mkdirSync(join(outside, "nested"), { recursive: true });
    symlinkSync(outside, join(source, "skills/outer"));
    expect(() => resolveSourceDir("outer/nested", "skill", source)).toThrow(/symlink/);
  });

  test("expands tilde and resolves relative paths against config", () => {
    expect(resolveConfiguredPath("~/source", "/tmp/config.toml")).toBe(join(homedir(), "source"));
    expect(resolveConfiguredPath("../source", "/tmp/config/config.toml")).toBe("/tmp/source");
    expect(resolveConfiguredPath("$HOME/source", "/tmp/config.toml")).toBe("/tmp/$HOME/source");
  });
});

describe("strict TOML loaders", () => {
  test("loads machine, root, profile, and pack documents", () => {
    const source = sourceFixture();
    const machine = join(temp(), "nested/config.toml");
    file(machine, `version = 1\nsource = ${JSON.stringify(source)}\nprofile = \"studio\"\n`);
    expect(loadMachineConfig(machine)).toEqual({ version: 1, source, profile: "studio" });
    expect(loadRootConfig(source).budgets.instructionLayerBytes).toBe(100);
    expect(loadProfileConfig(source, "studio")).toMatchObject({
      harnesses: ["codex", "claude-code"], template: "personal", packs: ["base"], skillsEnable: ["review"],
    });
    expect(loadPackConfig(join(source, "packs/base"))).toEqual({ version: 1, skills: ["review"] });
  });

  test("rejects unknown keys, versions, invalid budgets, harnesses, duplicates, and missing sources", () => {
    const source = sourceFixture();
    file(sourceRootConfigPath(source), "version = 1\nextra = true\n");
    expect(() => loadRootConfig(source)).toThrow(/unknown source root configuration key/);
    file(sourceRootConfigPath(source), "version = 2\n");
    expect(() => loadRootConfig(source)).toThrow(/version must be/);
    file(sourceRootConfigPath(source), "version = 1\n[budgets]\nskill_markdown_bytes = 0\n");
    expect(() => loadRootConfig(source)).toThrow(/positive integer/);
    file(join(source, "profiles/bad.toml"), "version = 1\nharnesses = [\"gemini\"]\ntemplate = \"personal\"\npacks = []\n");
    expect(() => loadProfileConfig(source, "bad")).toThrow(/unknown harness/);
    file(join(source, "profiles/bad.toml"), "version = 1\nharnesses = [\"codex\"]\ntemplate = \"personal\"\npacks = [\"base\", \"base\"]\n");
    expect(() => loadProfileConfig(source, "bad")).toThrow(/duplicate/);
    file(join(source, "profiles/bad.toml"), "version = 1\nharnesses = [\"codex\"]\ntemplate = \"missing\"\npacks = []\n");
    expect(() => loadProfileConfig(source, "bad")).toThrow(/missing template source/);
    const machine = join(temp(), "config.toml");
    file(machine, "version = 1\nsource = \"missing\"\nprofile = \"studio\"\n");
    expect(() => loadMachineConfig(machine)).toThrow(/not an existing directory/);
  });
});

describe("project configuration", () => {
  function projectFixture(): { root: string; config: string } {
    const root = temp();
    mkdirSync(join(root, "apps/ios"), { recursive: true });
    mkdirSync(join(projectSourceRoot(root), "templates/custom"), { recursive: true });
    mkdirSync(join(projectSourceRoot(root), "packs/deploy"), { recursive: true });
    const config = projectConfigPath(root);
    file(config, `version = 1\nharnesses = [\"codex\", \"claude-code\"]\n[budgets]\ninstruction_layer_bytes = 20000\n[[scopes]]\npath = \".\"\ntemplate = \"software\"\npacks = [\"base\"]\n[[scopes]]\npath = \"apps/ios/../ios\"\ntemplate = \"@project/custom\"\npacks = [\"@project/deploy\"]\nharnesses = [\"codex\"]\n`);
    return { root, config };
  }

  test("normalizes scopes, fills optional lists, and validates local sources", () => {
    const { config } = projectFixture();
    expect(loadProjectConfig(config)).toEqual({
      version: 1,
      harnesses: ["codex", "claude-code"],
      budgets: { instructionLayerBytes: 20000, effectiveInstructionBytes: undefined, skillMarkdownBytes: undefined },
      scopes: [
        { path: ".", template: "software", packs: ["base"], harnesses: undefined, skillsEnable: [], skillsDisable: [] },
        { path: "apps/ios", template: "@project/custom", packs: ["@project/deploy"], harnesses: ["codex"], skillsEnable: [], skillsDisable: [] },
      ],
    });
  });

  test("discovers config from a descendant or file", () => {
    const { root, config } = projectFixture();
    const descendant = join(root, "apps/ios/file.txt");
    file(descendant, "x");
    expect(discoverProjectConfig(join(root, "apps/ios"))).toBe(config);
    expect(discoverProjectConfig(descendant)).toBe(config);
  });

  test("rejects duplicate normalized scopes and harnesses outside defaults", () => {
    const { root, config } = projectFixture();
    file(config, `version = 1\nharnesses = [\"codex\"]\n[[scopes]]\npath = \"apps/ios\"\npacks = []\n[[scopes]]\npath = \"apps/./ios\"\npacks = []\n`);
    expect(() => loadProjectConfig(config)).toThrow(/duplicate normalized scope/);
    file(config, `version = 1\nharnesses = ["codex"]\n[[scopes]]\npath = "apps/ios"\npacks = []\n`);
    expect(() => loadProjectConfig(config)).toThrow(/Repository Scope/);
    file(config, `version = 1\nharnesses = [\"codex\"]\n[[scopes]]\npath = \".\"\npacks = []\nharnesses = [\"claude-code\"]\n`);
    expect(() => loadProjectConfig(config)).toThrow(/subset/);
    file(config, `version = 1\nharnesses = [\"codex\"]\n[[scopes]]\npath = \"..\"\npacks = []\n`);
    expect(() => loadProjectConfig(config)).toThrow(/escapes/);
    file(config, `version = 1\nharnesses = [\"codex\"]\n[[scopes]]\npath = \".\"\npacks = [\"base\"]\n[[scopes]]\npath = \"apps/ios\"\npacks = [\"base\"]\n`);
    expect(() => loadProjectConfig(config)).toThrow(/repeats inherited pack/);
    expect(() => discoverProjectConfig(temp())).toThrow(/no .*config\.toml found/);
  });
});
