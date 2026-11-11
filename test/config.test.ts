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
  sourceRootConfigPath,
} from "../src/config.ts";
import { loadSkill } from "../src/source.ts";

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
  file(sourceRootConfigPath(root), `[budgets]\ninstruction_layer_bytes = 100\n`);
  mkdirSync(join(root, "templates/personal"), { recursive: true });
  file(join(root, "templates/personal/default.md"), "hello\n");
  mkdirSync(join(root, "packs/base"), { recursive: true });
  file(join(root, "packs/base/pack.toml"), 'skills = ["review"]\n');
  mkdirSync(join(root, "skills/review"), { recursive: true });
  file(join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
  file(
    join(root, "profiles/studio.toml"),
    `harnesses = [\"codex\", \"claude\"]\ntemplate = \"personal\"\npacks = [\"base\"]\nskills_enable = [\"review\"]\nskills_disable = []\n[budgets]\neffective_instruction_bytes = 200\n`,
  );
  return root;
}

describe("Source IDs and paths", () => {
  test("parses unqualified, source-qualified, and project-qualified IDs", () => {
    expect(parseSourceId("software/default")).toEqual({ owner: undefined, name: "software/default", raw: "software/default" });
    expect(parseSourceId("source:software/default")).toEqual({ owner: "source", name: "software/default", raw: "source:software/default" });
    expect(parseSourceId("project:release")).toEqual({ owner: "project", name: "release", raw: "project:release" });
  });

  test.each(["", "/absolute", "../escape", "a//b", "a/./b", "a/../b", "a\\b", "@project/x", "other:x", "project:", "source:a:b", "a\0b"])(
    "rejects invalid Source ID %p",
    (value) => expect(() => parseSourceId(value)).toThrow(ConfigError),
  );

  test("resolves explicitly owned skills without fallback", async () => {
    const source = sourceFixture();
    const project = temp();
    file(join(projectSourceRoot(project), "skills/local/SKILL.md"), "---\nname: local\ndescription: Local\n---\n");
    expect((await loadSkill({ sourceRoot: source, projectRoot: project }, "source:review")).sourceDir).toBe(join(source, "skills/review"));
    expect((await loadSkill({ sourceRoot: source, projectRoot: project }, "project:local")).sourceDir).toBe(join(project, ".config/agentsmith/skills/local"));
    await expect(loadSkill({ sourceRoot: source, projectRoot: project }, "project:review")).rejects.toThrow(/missing skill source/);
  });

  test("rejects symlink sources and project source ancestors", async () => {
    const source = sourceFixture();
    symlinkSync(join(source, "skills/review"), join(source, "skills/link"));
    await expect(loadSkill({ sourceRoot: source }, "source:link")).rejects.toThrow(/symlink/);
    const outside = temp();
    mkdirSync(join(outside, "nested"), { recursive: true });
    symlinkSync(outside, join(source, "skills/outer"));
    await expect(loadSkill({ sourceRoot: source }, "source:outer/nested")).rejects.toThrow(/symlink/);

    const project = temp();
    const externalConfig = temp();
    file(join(externalConfig, "agentsmith/skills/external/SKILL.md"), "---\nname: external\ndescription: External\n---\n");
    symlinkSync(externalConfig, join(project, ".config"));
    await expect(loadSkill({ projectRoot: project }, "external")).rejects.toThrow(/project source.*symlink/);
  });

  test("expands tilde and resolves relative paths against config", () => {
    expect(resolveConfiguredPath("~/source", "/tmp/config.toml")).toBe(join(homedir(), "source"));
    expect(resolveConfiguredPath("../source", "/tmp/config/config.toml")).toBe("/tmp/source");
    expect(resolveConfiguredPath("$HOME/source", "/tmp/config.toml")).toBe("/tmp/$HOME/source");
  });
});

describe("strict TOML loaders", () => {
  test("loads versionless configuration and a manifest-free pack", () => {
    const source = temp();
    file(sourceRootConfigPath(source), "");
    mkdirSync(join(source, "templates/personal"), { recursive: true });
    file(join(source, "templates/personal/default.md"), "hello\n");
    mkdirSync(join(source, "packs/base"), { recursive: true });
    file(join(source, "profiles/studio.toml"), 'harnesses = ["codex"]\ntemplate = "personal"\npacks = ["base"]\n');
    const machine = join(temp(), "config.toml");
    file(machine, `source = ${JSON.stringify(source)}\nprofile = "studio"\n`);
    const project = temp();
    const projectConfig = projectConfigPath(project);
    file(projectConfig, 'harnesses = ["codex"]\n[[scopes]]\npath = "."\npacks = []\n');

    expect(loadMachineConfig(machine)).toEqual({ source, profile: "studio" });
    expect(loadRootConfig(source)).toEqual({ budgets: {} });
    expect(loadProfileConfig(source, "studio")).toMatchObject({
      harnesses: ["codex"],
      template: "personal",
      packs: ["base"],
    });
    expect(loadPackConfig(join(source, "packs/base"))).toEqual({ skills: [] });
    file(join(source, "packs/base/pack.toml"), "");
    expect(loadPackConfig(join(source, "packs/base"))).toEqual({ skills: [] });
    expect(loadProjectConfig(projectConfig)).toMatchObject({ harnesses: ["codex"], scopes: [{ path: "." }] });
  });

  test("rejects the legacy version key in every configuration document", () => {
    const source = sourceFixture();
    file(sourceRootConfigPath(source), "version = 1\n");
    expect(() => loadRootConfig(source)).toThrow(/unknown source root configuration key: version/);

    const machine = join(temp(), "config.toml");
    file(machine, `version = 1\nsource = ${JSON.stringify(source)}\nprofile = "studio"\n`);
    expect(() => loadMachineConfig(machine)).toThrow(/unknown machine configuration key: version/);

    file(join(source, "profiles/studio.toml"), 'version = 1\nharnesses = ["codex"]\ntemplate = "personal"\npacks = []\n');
    expect(() => loadProfileConfig(source, "studio")).toThrow(/unknown profile key: version/);

    file(join(source, "packs/base/pack.toml"), "version = 1\n");
    expect(() => loadPackConfig(join(source, "packs/base"))).toThrow(/unknown pack key: version/);

    const project = temp();
    const config = projectConfigPath(project);
    file(config, 'version = 1\nharnesses = ["codex"]\n[[scopes]]\npath = "."\npacks = []\n');
    expect(() => loadProjectConfig(config)).toThrow(/unknown project configuration key: version/);
  });

  test("rejects unsupported pack manifest fields", () => {
    const pack = join(temp(), "packs/base");
    file(join(pack, "pack.toml"), 'description = "base instructions"\n');
    expect(() => loadPackConfig(pack)).toThrow(/unknown pack key.*description/);
  });

  test("rejects live and dangling pack manifest symlinks", () => {
    const root = temp();
    const manifest = join(root, "manifest.toml");
    file(manifest, 'skills = ["review"]\n');
    const livePack = join(root, "packs/live");
    mkdirSync(livePack, { recursive: true });
    symlinkSync(manifest, join(livePack, "pack.toml"));
    expect(() => loadPackConfig(livePack)).toThrow(/regular non-symlink file/);

    const danglingPack = join(root, "packs/dangling");
    mkdirSync(danglingPack, { recursive: true });
    symlinkSync(join(root, "missing.toml"), join(danglingPack, "pack.toml"));
    expect(() => loadPackConfig(danglingPack)).toThrow(/regular non-symlink file/);
  });

  test("loads machine, root, profile, and pack documents", () => {
    const source = sourceFixture();
    const machine = join(temp(), "nested/config.toml");
    file(machine, `source = ${JSON.stringify(source)}\nprofile = \"studio\"\n`);
    expect(loadMachineConfig(machine)).toEqual({ source, profile: "studio" });
    expect(loadRootConfig(source).budgets.instructionLayerBytes).toBe(100);
    expect(loadProfileConfig(source, "studio")).toMatchObject({
      harnesses: ["codex", "claude"],
      template: "personal",
      packs: ["base"],
      skillsEnable: ["review"],
    });
    expect(loadPackConfig(join(source, "packs/base"))).toEqual({ skills: ["review"] });
  });

  test("rejects invalid documents while deferring source discovery to planning", () => {
    const source = sourceFixture();
    file(sourceRootConfigPath(source), "extra = true\n");
    expect(() => loadRootConfig(source)).toThrow(/unknown source root configuration key/);
    file(sourceRootConfigPath(source), "[budgets]\nskill_markdown_bytes = 0\n");
    expect(() => loadRootConfig(source)).toThrow(/positive integer/);
    file(join(source, "profiles/bad.toml"), 'harnesses = ["gemini"]\ntemplate = "personal"\npacks = []\n');
    expect(() => loadProfileConfig(source, "bad")).toThrow(/unknown harness/);
    file(join(source, "profiles/bad.toml"), 'harnesses = ["codex"]\ntemplate = "personal"\npacks = ["base", "base"]\n');
    expect(() => loadProfileConfig(source, "bad")).toThrow(/duplicate/);
    file(join(source, "profiles/bad.toml"), 'harnesses = ["codex"]\ntemplate = "missing"\npacks = []\n');
    expect(loadProfileConfig(source, "bad").template).toBe("missing");
    const machine = join(temp(), "config.toml");
    file(machine, 'source = "missing"\nprofile = "studio"\n');
    expect(() => loadMachineConfig(machine)).toThrow(/not an existing directory/);
  });
});

describe("profile extends", () => {
  function chainFixture(): string {
    const source = sourceFixture();
    file(
      join(source, "profiles/mac.toml"),
      [
        'harnesses = ["codex", "claude"]',
        'template = "personal"',
        'packs = ["base", "macos"]',
        'skills_enable = ["review", "shared"]',
        'skills_disable = ["publish"]',
        "[budgets]",
        "instruction_layer_bytes = 10",
        "effective_instruction_bytes = 20",
        "",
      ].join("\n"),
    );
    file(
      join(source, "profiles/studio.toml"),
      ['extends = "mac"', 'packs = ["server"]', 'skills_enable = ["shared", "deploy"]', "[budgets]", "effective_instruction_bytes = 30", ""].join("\n"),
    );
    file(
      join(source, "profiles/desk.toml"),
      ['extends = "studio"', 'harnesses = ["codex"]', 'template = "desk"', 'packs = ["gpu"]', 'skills_disable = ["deploy"]', ""].join("\n"),
    );
    return source;
  }

  test("merges a chain root ancestor first", () => {
    const source = chainFixture();
    expect(loadProfileConfig(source, "studio")).toEqual({
      harnesses: ["codex", "claude"],
      template: "personal",
      packs: ["base", "macos", "server"],
      skillsEnable: ["review", "shared", "deploy"],
      skillsDisable: ["publish"],
      budgets: { instructionLayerBytes: 10, effectiveInstructionBytes: 30 },
      chain: ["mac", "studio"],
      packProfiles: { base: "mac", macos: "mac", server: "studio" },
    });
    expect(loadProfileConfig(source, "desk")).toMatchObject({
      harnesses: ["codex"],
      template: "desk",
      packs: ["base", "macos", "server", "gpu"],
      skillsDisable: ["publish", "deploy"],
      budgets: { instructionLayerBytes: 10, effectiveInstructionBytes: 30 },
      chain: ["mac", "studio", "desk"],
      packProfiles: { gpu: "desk", server: "studio", base: "mac" },
    });
  });

  test("a profile without extends reports a single-entry chain", () => {
    expect(loadProfileConfig(sourceFixture(), "studio")).toMatchObject({ chain: ["studio"], packProfiles: { base: "studio" } });
  });

  test("rejects cycles, including self-extension", () => {
    const source = chainFixture();
    file(join(source, "profiles/mac.toml"), 'extends = "desk"\n');
    expect(() => loadProfileConfig(source, "desk")).toThrow(/profile extends cycle: desk -> studio -> mac -> desk/);
    file(join(source, "profiles/self.toml"), 'extends = "self"\n');
    expect(() => loadProfileConfig(source, "self")).toThrow(/profile extends cycle: self -> self/);
  });

  test("rejects a missing parent", () => {
    const source = chainFixture();
    file(join(source, "profiles/orphan.toml"), 'extends = "nowhere"\npacks = []\n');
    expect(() => loadProfileConfig(source, "orphan")).toThrow(/profile "orphan" extends missing profile "nowhere"/);
  });

  test("rejects ownership-qualified and invalid parents", () => {
    const source = chainFixture();
    file(join(source, "profiles/bad.toml"), 'extends = "source:mac"\n');
    expect(() => loadProfileConfig(source, "bad")).toThrow(/ownership-qualified/);
    file(join(source, "profiles/bad.toml"), 'extends = ""\n');
    expect(() => loadProfileConfig(source, "bad")).toThrow(/extends must be a nonempty string/);
    file(join(source, "profiles/bad.toml"), 'extends = "../escape"\n');
    expect(() => loadProfileConfig(source, "bad")).toThrow(/invalid Source ID/);
  });

  test("rejects a pack repeated across the chain", () => {
    const source = chainFixture();
    file(join(source, "profiles/studio.toml"), 'extends = "mac"\npacks = ["server", "macos"]\n');
    expect(() => loadProfileConfig(source, "studio")).toThrow(/profile "studio" repeats pack "macos" inherited from profile "mac"/);
    file(join(source, "profiles/studio.toml"), 'extends = "mac"\npacks = ["server"]\n');
    file(join(source, "profiles/desk.toml"), 'extends = "studio"\npacks = ["base"]\n');
    expect(() => loadProfileConfig(source, "desk")).toThrow(/profile "desk" repeats pack "base" inherited from profile "mac"/);
  });

  test("requires the resolved profile to set harnesses and template", () => {
    const source = chainFixture();
    file(join(source, "profiles/partial.toml"), 'packs = ["base"]\n');
    expect(() => loadProfileConfig(source, "partial")).toThrow(/profile "partial" must set harnesses and template/);
    file(join(source, "profiles/root.toml"), 'packs = ["base"]\n');
    file(join(source, "profiles/leaf.toml"), 'extends = "root"\nharnesses = ["codex"]\npacks = ["server"]\n');
    expect(() => loadProfileConfig(source, "leaf")).toThrow(
      /leaf\.toml: profile "leaf" must set harnesses and template, directly or through extends \(chain: root -> leaf\)/,
    );
    file(join(source, "profiles/leaf.toml"), 'extends = "root"\nharnesses = ["codex"]\ntemplate = "personal"\npacks = ["server"]\n');
    expect(loadProfileConfig(source, "leaf")).toMatchObject({ harnesses: ["codex"], template: "personal", packs: ["base", "server"], chain: ["root", "leaf"] });
    file(join(source, "profiles/root.toml"), 'harnesses = ["codex"]\ntemplate = "personal"\npacks = ["base"]\n');
    file(join(source, "profiles/leaf.toml"), 'extends = "root"\nharnesses = []\n');
    expect(() => loadProfileConfig(source, "leaf")).toThrow(/leaf\.toml: harnesses must not be empty/);
  });
});

describe("project configuration", () => {
  function projectFixture(): { root: string; config: string } {
    const root = temp();
    mkdirSync(join(root, "apps/ios"), { recursive: true });
    mkdirSync(join(projectSourceRoot(root), "templates/custom"), { recursive: true });
    mkdirSync(join(projectSourceRoot(root), "packs/deploy"), { recursive: true });
    const config = projectConfigPath(root);
    file(
      config,
      `harnesses = [\"codex\", \"claude\"]\n[budgets]\ninstruction_layer_bytes = 20000\n[[scopes]]\npath = \".\"\ntemplate = \"software\"\npacks = [\"base\"]\n[[scopes]]\npath = \"apps/ios/../ios\"\ntemplate = \"project:custom\"\npacks = [\"project:deploy\"]\nharnesses = [\"codex\"]\n`,
    );
    return { root, config };
  }

  test("normalizes scopes, fills optional lists, and parses owned source IDs", () => {
    const { config } = projectFixture();
    expect(loadProjectConfig(config)).toEqual({
      harnesses: ["codex", "claude"],
      budgets: { instructionLayerBytes: 20000, effectiveInstructionBytes: undefined, skillMarkdownBytes: undefined },
      scopes: [
        { path: ".", template: "software", packs: ["base"], harnesses: undefined, skillsEnable: [], skillsDisable: [] },
        { path: "apps/ios", template: "project:custom", packs: ["project:deploy"], harnesses: ["codex"], skillsEnable: [], skillsDisable: [] },
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
    file(config, `harnesses = [\"codex\"]\n[[scopes]]\npath = \"apps/ios\"\npacks = []\n[[scopes]]\npath = \"apps/./ios\"\npacks = []\n`);
    expect(() => loadProjectConfig(config)).toThrow(/duplicate normalized scope/);
    file(config, `harnesses = ["codex"]\n[[scopes]]\npath = "apps/ios"\npacks = []\n`);
    expect(() => loadProjectConfig(config)).toThrow(/Repository Scope/);
    file(config, `harnesses = [\"codex\"]\n[[scopes]]\npath = \".\"\npacks = []\nharnesses = [\"claude\"]\n`);
    expect(() => loadProjectConfig(config)).toThrow(/subset/);
    file(config, `harnesses = ["claude-code"]\n[[scopes]]\npath = "."\npacks = []\n`);
    expect(() => loadProjectConfig(config)).toThrow(/"claude-code", which was renamed to "claude"/);
    file(config, `harnesses = [\"codex\"]\n[[scopes]]\npath = \"..\"\npacks = []\n`);
    expect(() => loadProjectConfig(config)).toThrow(/escapes/);
    file(config, `harnesses = [\"codex\"]\n[[scopes]]\npath = \".\"\npacks = [\"base\"]\n[[scopes]]\npath = \"apps/ios\"\npacks = [\"base\"]\n`);
    expect(() => loadProjectConfig(config)).toThrow(/repeats inherited pack/);
    expect(() => discoverProjectConfig(temp())).toThrow(/no .*config\.toml found/);
  });
});
