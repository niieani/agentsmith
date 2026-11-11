import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendPackSkill } from "../src/adopt-skill.ts";

const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function run(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

const skill = (name: string, body = "Body.\n") => `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${body}`;

/** Files below a directory, relative, with content. */
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, `${prefix}${entry.name}/`);
      else result[`${prefix}${entry.name}`] = await readFile(path, "utf8");
    }
  };
  await visit(root, "");
  return result;
}

describe("appendPackSkill", () => {
  test("creates, appends inline and multi-line, and keeps other formatting", () => {
    expect(appendPackSkill(undefined, "a")).toBe('skills = ["a"]\n');
    expect(appendPackSkill("", "a")).toBe('skills = ["a"]\n');
    expect(appendPackSkill("skills = []\n", "a")).toBe('skills = ["a"]\n');
    expect(appendPackSkill('# Base pack\nskills = ["x", "y"] # enabled\n', "a")).toBe('# Base pack\nskills = ["x", "y", "a"] # enabled\n');
    expect(appendPackSkill('skills = [\n  "x",\n  "y",\n]\n', "a")).toBe('skills = [\n  "x",\n  "y",\n  "a",\n]\n');
    expect(appendPackSkill('skills = ["a"]\n', "a")).toBe('skills = ["a"]\n');
    expect(appendPackSkill("# comment only\n", "a")).toBe('skills = ["a"]\n# comment only\n');
  });
});

async function globalFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-exclusive-"));
  const realHome = join(root, "real-home");
  const home = join(root, "home");
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const source = join(root, "source");
  await mkdir(home, { recursive: true });
  await put(join(realHome, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.test\n[init]\n\tdefaultBranch = main\n");
  const env = { ...Bun.env, HOME: realHome, CODEX_HOME: undefined, GIT_CONFIG_GLOBAL: undefined };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run(["git", ...args], cwd, env);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  await mkdir(seed, { recursive: true });
  await git(root, "init", "--bare", remote);
  await git(seed, "init");
  await put(join(seed, "agentsmith.toml"), "");
  await put(join(seed, "profiles", "base.toml"), ["exclusive = true", 'exclusive_allow = ["vendor-*"]', 'packs = ["base"]', ""].join("\n"));
  await put(join(seed, "profiles", "test.toml"), ['extends = "base"', 'harnesses = ["generic", "codex", "claude"]', 'template = "base"', ""].join("\n"));
  await put(join(seed, "templates", "base", "default.md"), "# Global\n");
  await put(join(seed, "packs", "base", "pack.toml"), '# Base pack\nskills = ["review"]\n');
  await put(join(seed, "skills", "review", "SKILL.md"), skill("review"));
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "source");
  await git(seed, "push", "-u", remote, "HEAD:main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", remote, source);
  const config = join(root, "config.toml");
  await put(config, `source = "source"\nprofile = "test"\nhome = "home"\n`);
  const asmith = (...args: string[]) => run(["bun", cli, ...args, "--config", config], root, env);
  return { root, home, source, remote, config, git, asmith };
}

describe("global exclusive mode", () => {
  test("reports, allows, quarantines, and adopts unmanaged skills", async () => {
    const f = await globalFixture();
    const stray = join(f.home, ".claude", "skills", "stray");
    await put(join(stray, "SKILL.md"), skill("stray", "Stray skill.\n"));
    await put(join(stray, "scripts", "run.sh"), "#!/bin/sh\necho stray\n");
    await put(join(f.home, ".agents", "skills", "vendor-tool", "SKILL.md"), skill("vendor-tool"));
    await put(join(f.home, ".codex", "skills", ".system", "builtin", "SKILL.md"), skill("builtin"));
    const original = await tree(stray);

    const lint = await f.asmith("global", "lint");
    expect(lint.exitCode).toBe(5);
    expect(lint.stderr).toContain(stray);
    expect(lint.stderr).not.toContain("vendor-tool");
    expect(lint.stderr).not.toContain(".system");
    const refused = await f.asmith("global", "generate");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain("asmith global adopt --skill NAME");
    expect(existsSync(stray)).toBeTrue();

    const existing = await f.asmith("global", "adopt", "--skill", "review");
    expect(existing.exitCode).toBe(2);
    expect(existing.stderr).toContain("already exists in the source tree");
    const missing = await f.asmith("global", "adopt", "--skill", "nothing");
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("No unmanaged global skill named nothing");
    const dry = await f.asmith("global", "adopt", "--skill", "stray", "--dry-run");
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(existsSync(join(f.source, "skills", "stray"))).toBeFalse();

    const adopted = await f.asmith("global", "adopt", "--skill", "stray");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(await tree(join(f.source, "skills", "stray"))).toEqual(original);
    expect(await readFile(join(f.source, "packs", "base", "pack.toml"), "utf8")).toBe('# Base pack\nskills = ["review", "stray"]\n');
    expect(await f.git(f.source, "log", "-1", "--name-only", "--format=%s")).toBe(
      "Adopt skill stray\n\npacks/base/pack.toml\nskills/stray/SKILL.md\nskills/stray/scripts/run.sh\n",
    );
    expect(await f.git(f.source, "status", "--porcelain")).toBe("");
    // The skill regenerates byte-identically and is now managed in every root the profile writes.
    expect(await tree(stray)).toEqual(original);
    expect(await tree(join(f.home, ".agents", "skills", "stray"))).toEqual(original);
    expect((await readdir(join(f.home, ".agents", "agentsmith", "backups"))).length).toBe(1);
    expect((await f.asmith("global", "lint")).exitCode).toBe(0);

    // With --on-modified=backup an unmanaged skill is moved aside, and the run records it.
    const other = join(f.home, ".agents", "skills", "other");
    await put(join(other, "SKILL.md"), skill("other"));
    const synced = await f.asmith("global", "sync", "--on-modified=backup");
    expect(synced.exitCode, synced.stderr).toBe(0);
    expect(synced.stderr).toContain(`WARNING unmanaged-skill-backup: moved unmanaged skill ${other}`);
    expect(existsSync(other)).toBeFalse();
    const status = JSON.parse(await readFile(join(f.home, ".agents", "agentsmith", "status.json"), "utf8"));
    expect(status.outcome).toBe("success");
    expect(status.warnings.join("\n")).toContain("unmanaged-skill-backup");
    const backup = status.backups.find((item: { reason: string }) => item.reason === "unmanaged");
    expect(backup.path).toBe(other);
    expect(backup.backup.startsWith(join(f.home, ".agents", "agentsmith", "backups"))).toBeTrue();
    expect(await readFile(join(backup.backup, "SKILL.md"), "utf8")).toBe(skill("other"));
    expect(existsSync(join(f.home, ".agents", "skills", "vendor-tool"))).toBeTrue();
  });

  test("adopts a skill linked into several roots once and pushes with --push", async () => {
    const f = await globalFixture();
    const real = join(f.home, ".agents", "skills", "linked");
    await put(join(real, "SKILL.md"), skill("linked"));
    await mkdir(join(f.home, ".claude", "skills"), { recursive: true });
    await symlink(real, join(f.home, ".claude", "skills", "linked"));
    const adopted = await f.asmith("global", "adopt", "--skill", "linked", "--push");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("and pushed");
    expect(await f.git(f.remote, "log", "-1", "--format=%s", "main")).toBe("Adopt skill linked\n");
    expect(await readFile(join(f.home, ".claude", "skills", "linked", "SKILL.md"), "utf8")).toBe(skill("linked"));
    expect(await readFile(join(f.home, ".agents", "skills", "linked", "SKILL.md"), "utf8")).toBe(skill("linked"));
  });

  test("an unmanaged skill colliding with a planned one is quarantined instead of failing planning", async () => {
    const f = await globalFixture();
    // Codex reads ~/.codex/skills too, so this copy would make review visible twice.
    const shadow = join(f.home, ".codex", "skills", "review");
    await put(join(shadow, "SKILL.md"), skill("review", "Old copy.\n"));
    const lint = await f.asmith("global", "lint");
    expect(lint.exitCode).toBe(5);
    expect(lint.stderr).not.toContain("planned-unmanaged-skill-collision");
    const generated = await f.asmith("global", "generate", "--on-modified=backup");
    expect(generated.exitCode, generated.stderr).toBe(0);
    expect(existsSync(shadow)).toBeFalse();
    expect(await readFile(join(f.home, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(skill("review"));
  });

  test("--no-commit leaves the adoption for review", async () => {
    const f = await globalFixture();
    await put(join(f.home, ".claude", "skills", "draft", "SKILL.md"), skill("draft"));
    const adopted = await f.asmith("global", "adopt", "--skill", "draft", "--no-commit");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("not committed");
    expect(await f.git(f.source, "status", "--porcelain")).toBe(" M packs/base/pack.toml\n?? skills/draft/\n");
  });
});

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-exclusive-project-"));
  const project = join(root, "project");
  const config = join(project, ".config", "agentsmith");
  await put(
    join(config, "config.toml"),
    [
      'harnesses = ["generic", "claude"]',
      "exclusive = true",
      'exclusive_allow = ["kept-*"]',
      "",
      "[[scopes]]",
      'path = "."',
      'template = "base"',
      'packs = ["local"]',
      "",
      "[[scopes]]",
      'path = "app"',
      'template = "base"',
      "packs = []",
      "exclusive = false",
      "",
    ].join("\n"),
  );
  await put(join(config, "templates", "base", "default.md"), "# Project\n");
  await put(join(config, "packs", "local", "pack.toml"), "");
  await put(join(project, "app", "README.md"), "app\n");
  const env = { ...Bun.env, HOME: root, CODEX_HOME: undefined };
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args], project, env);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  await git("init");
  await git("config", "user.email", "fixture@example.test");
  await git("config", "user.name", "Fixture");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  const asmith = (...args: string[]) => run(["bun", cli, ...args], project, env);
  return { root, project, config, git, asmith };
}

describe("project exclusive mode", () => {
  test("reports per scope, quarantines into the Git directory, and adopts into the project source", async () => {
    const f = await projectFixture();
    const stray = join(f.project, ".claude", "skills", "stray");
    await put(join(stray, "SKILL.md"), skill("stray"));
    await put(join(f.project, ".agents", "skills", "kept-tool", "SKILL.md"), skill("kept-tool"));
    // The app scope turns exclusive mode off.
    await put(join(f.project, "app", ".claude", "skills", "app-only", "SKILL.md"), skill("app-only"));

    const lint = await f.asmith("project", "lint");
    expect(lint.exitCode).toBe(5);
    expect(lint.stderr).toContain(stray);
    expect(lint.stderr).toContain("asmith project adopt --skill NAME");
    expect(lint.stderr).not.toContain("kept-tool");
    expect(lint.stderr).not.toContain("app-only");
    expect((await f.asmith("project", "generate")).exitCode).toBe(5);

    const generated = await f.asmith("project", "generate", "--on-modified=backup");
    expect(generated.exitCode, generated.stderr).toBe(0);
    expect(generated.stderr).toContain(`WARNING unmanaged-skill-backup: moved unmanaged skill ${stray}`);
    expect(existsSync(stray)).toBeFalse();
    const backups = join(f.project, ".git", "agentsmith", "backups");
    const [stamp] = await readdir(backups);
    expect(await readFile(join(backups, stamp!, stray.slice(1), "SKILL.md"), "utf8")).toBe(skill("stray"));
    await f.git("add", ".");
    await f.git("commit", "-m", "generated");

    const thing = join(f.project, ".agents", "skills", "thing");
    await put(join(thing, "SKILL.md"), skill("thing"));
    expect((await f.asmith("project", "adopt", "--skill", "thing", "--push")).exitCode).toBe(2);
    const adopted = await f.asmith("project", "adopt", "--skill", "thing");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(await readFile(join(f.config, "skills", "thing", "SKILL.md"), "utf8")).toBe(skill("thing"));
    expect(await readFile(join(f.config, "packs", "local", "pack.toml"), "utf8")).toBe('skills = ["thing"]\n');
    expect(await readFile(join(thing, "SKILL.md"), "utf8")).toBe(skill("thing"));
    expect(await readFile(join(f.project, ".claude", "skills", "thing", "SKILL.md"), "utf8")).toBe(skill("thing"));
    // Project adoption never commits.
    expect(await f.git("log", "-1", "--format=%s")).toBe("generated\n");
    expect((await f.asmith("project", "adopt")).exitCode).toBe(2);
  });
});
