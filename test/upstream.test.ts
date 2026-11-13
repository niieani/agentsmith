import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadProfileConfig } from "../src/config.ts";
import { matchProfileProject, remoteKey } from "../src/project.ts";
import { commitAll, projectFixture, put, skillMd, type ProjectFixture } from "./support/project.ts";

/** A third-party repository with committed instructions and a skill, and a Source Repository with personal inputs. */
async function upstreamFixture(options: { claude?: boolean } = {}): Promise<ProjectFixture> {
  const f = await projectFixture("agentsmith-upstream-");
  await put(join(f.project, "AGENTS.md"), "# Upstream\n\nUpstream rules.\n");
  if (options.claude !== false) await put(join(f.project, "CLAUDE.md"), "Upstream Claude rules.\n");
  await put(join(f.project, ".claude", "skills", "upstream-skill", "SKILL.md"), skillMd("upstream-skill"));
  await commitAll(f, "upstream");
  await f.git("remote", "add", "origin", "git@github.com:Acme/tool.git");
  await put(join(f.source, "agentsmith.toml"), "");
  await put(join(f.source, "profiles", "me.toml"), ['harnesses = ["generic", "codex", "claude"]', 'template = "mine"', ""].join("\n"));
  await put(join(f.source, "templates", "mine", "default.md"), "# Mine\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(f.source, "packs", "mine", "pack.toml"), 'skills = ["my-skill"]\n');
  await put(join(f.source, "packs", "mine", "instructions", "notes", "10-mine.md"), "My note.\n");
  await put(join(f.source, "skills", "my-skill", "SKILL.md"), skillMd("my-skill"));
  await put(f.machine, `source = ${JSON.stringify(f.source)}\nprofile = "me"\n`);
  return f;
}

async function projectConfig(f: ProjectFixture, upstream: "keep" | "replace"): Promise<void> {
  await put(
    join(f.config, "config.toml"),
    [
      `upstream = "${upstream}"`,
      'harnesses = ["generic", "codex", "claude"]',
      "",
      "[[scopes]]",
      'path = "."',
      'template = "mine"',
      'packs = ["mine"]',
      "",
    ].join("\n"),
  );
}

const settings = async (f: ProjectFixture) => JSON.parse(await readFile(join(f.project, ".claude", "settings.local.json"), "utf8"));

describe("third-party repositories", () => {
  test("keep puts the personal layer after upstream AGENTS.md and beside upstream CLAUDE.md, without touching committed files", async () => {
    const f = await upstreamFixture();
    await projectConfig(f, "keep");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toBe("# Upstream\n\nUpstream rules.\n\n# Mine\n\nMy note.\n");
    expect(await readFile(join(f.project, "CLAUDE.local.md"), "utf8")).toBe("# Mine\n\nMy note.\n");
    expect(existsSync(join(f.project, ".claude", "settings.local.json"))).toBeFalse();
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe("# Upstream\n\nUpstream rules.\n");
    expect(await readFile(join(f.project, "CLAUDE.md"), "utf8")).toBe("Upstream Claude rules.\n");
    expect(existsSync(join(f.project, ".claude", "skills", "my-skill", "SKILL.md"))).toBeTrue();
    expect(existsSync(join(f.project, ".claude", "skills", "upstream-skill", "SKILL.md"))).toBeTrue();
    // Nothing shows up in Git: personal files, generated skills, and the personal configuration are excluded.
    expect(await f.git("status", "--porcelain")).toBe("");
    const exclude = await readFile(join(f.project, ".git", "info", "exclude"), "utf8");
    for (const entry of ["/AGENTS.override.md", "/CLAUDE.local.md", "/.agents/skills/my-skill/", "/.claude/skills/my-skill/", "/.config/agentsmith/"])
      expect(exclude).toContain(`${entry}\n`);

    // Upstream changes flow into the override on the next generation.
    await put(join(f.project, "AGENTS.md"), "# Upstream\n\nNew upstream rules.\n");
    await commitAll(f, "upstream change");
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toContain("New upstream rules.");
  });

  test("replace holds only the personal layer and excludes the upstream CLAUDE.md", async () => {
    const f = await upstreamFixture();
    await projectConfig(f, "replace");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toBe("# Mine\n\nMy note.\n");
    expect(await readFile(join(f.project, "CLAUDE.local.md"), "utf8")).toBe("@AGENTS.override.md\n");
    expect((await settings(f)).claudeMdExcludes).toEqual([join(f.project, "CLAUDE.md")]);
    expect(await readFile(join(f.project, "CLAUDE.md"), "utf8")).toBe("Upstream Claude rules.\n");
    expect(await f.git("status", "--porcelain")).toBe("");

    // Switching back to keep drops the exclude.
    await projectConfig(f, "keep");
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(existsSync(join(f.project, ".claude", "settings.local.json"))).toBeFalse();
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toStartWith("# Upstream");

    // Clean removes the files agentsmith added; the shared exclude lines stay.
    const cleaned = await f.asmith("project", "clean", "--yes");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeFalse();
    expect(existsSync(join(f.project, ".claude", "skills", "my-skill"))).toBeFalse();
    expect(existsSync(join(f.project, ".claude", "skills", "upstream-skill", "SKILL.md"))).toBeTrue();
    expect(await readFile(join(f.project, ".git", "info", "exclude"), "utf8")).toContain("/.claude/skills/my-skill/\n");
    expect(await f.git("status", "--porcelain")).toBe("");
  });

  test("keep imports an upstream AGENTS.md that Claude would otherwise stop reading", async () => {
    const f = await upstreamFixture({ claude: false });
    await projectConfig(f, "keep");
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(await readFile(join(f.project, "CLAUDE.local.md"), "utf8")).toBe("@AGENTS.md\n\n# Mine\n\nMy note.\n");
  });

  test("a profile [[projects]] entry configures a repository without its own config, matched by remote URL or path", async () => {
    const f = await upstreamFixture();
    await put(
      join(f.source, "profiles", "me.toml"),
      [
        'harnesses = ["generic", "codex", "claude"]',
        'template = "mine"',
        "",
        "[[projects]]",
        'remote = "https://github.com/Acme/tool"',
        'packs = ["mine"]',
        'template = "mine"',
        'harnesses = ["codex"]',
        "",
      ].join("\n"),
    );
    const result = await f.asmith("project", "generate");
    expect(result.exitCode, result.stderr).toBe(0);
    // Default keep, Codex only.
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toBe("# Upstream\n\nUpstream rules.\n\n# Mine\n\nMy note.\n");
    expect(existsSync(join(f.project, "CLAUDE.local.md"))).toBeFalse();
    expect(existsSync(join(f.project, ".codex", "skills", "my-skill", "SKILL.md"))).toBeTrue();
    expect(await f.git("status", "--porcelain")).toBe("");
    expect((await f.asmith("project", "explain")).stdout).toContain(join(f.source, "profiles", "me.toml"));

    await put(
      join(f.source, "profiles", "me.toml"),
      [
        'harnesses = ["codex"]',
        'template = "mine"',
        "",
        "[[projects]]",
        `path = ${JSON.stringify(f.project)}`,
        'upstream = "replace"',
        'packs = ["mine"]',
        'template = "mine"',
        "",
      ].join("\n"),
    );
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toBe("# Mine\n\nMy note.\n");

    await rm(join(f.source, "profiles", "me.toml"));
    await put(join(f.source, "profiles", "me.toml"), ['harnesses = ["codex"]', 'template = "mine"', "", "[[projects]]", 'path = "/nowhere"', ""].join("\n"));
    const unmatched = await f.asmith("project", "generate");
    expect(unmatched.exitCode).toBe(2);
    expect(unmatched.stderr).toContain(`no [[projects]] entry of profile "me" matches ${f.project}`);
  });

  test("never replaces a committed file of the repository", async () => {
    const f = await upstreamFixture();
    await put(join(f.project, "CLAUDE.local.md"), "Committed by upstream.\n");
    await commitAll(f, "odd upstream");
    await projectConfig(f, "keep");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("never writes a repository's committed files");
    expect(result.stderr).toContain(join(f.project, "CLAUDE.local.md"));
    expect(await readFile(join(f.project, "CLAUDE.local.md"), "utf8")).toBe("Committed by upstream.\n");
  });
});

describe("profile project entries", () => {
  test("normalizes remotes across SSH, HTTPS, and host-path forms", () => {
    for (const url of ["git@github.com:Acme/tool.git", "ssh://git@github.com/Acme/tool", "https://GitHub.com/Acme/tool/", "github.com/Acme/tool.git"]) {
      expect(remoteKey(url)).toBe("github.com/Acme/tool");
    }
    expect(remoteKey("https://gitlab.com/acme/tool")).not.toBe(remoteKey("https://github.com/acme/tool"));
  });

  test("parses entries, defaults upstream to keep, and lists the nearest profile first", async () => {
    const f = await projectFixture("agentsmith-profile-projects-");
    await put(
      join(f.source, "profiles", "base.toml"),
      ['harnesses = ["codex"]', 'template = "t"', "[[projects]]", 'remote = "github.com/acme/a"', ""].join("\n"),
    );
    await put(
      join(f.source, "profiles", "me.toml"),
      ['extends = "base"', "[[projects]]", 'remote = "github.com/acme/a"', 'upstream = "replace"', "[[projects]]", 'path = "repo"', ""].join("\n"),
    );
    const profile = loadProfileConfig(f.source, "me");
    expect(profile.projects.map((entry) => [entry.remote ?? entry.path, entry.upstream])).toEqual([
      ["github.com/acme/a", "replace"],
      [join(f.source, "profiles", "repo"), "keep"],
      ["github.com/acme/a", "keep"],
    ]);
    expect(matchProfileProject(profile.projects, "/x", ["git@github.com:acme/a.git"])?.upstream).toBe("replace");
    expect(matchProfileProject(profile.projects, "/x", ["git@github.com:acme/b.git"])).toBeUndefined();

    for (const [entry, message] of [
      ['path = "a"\nremote = "b"', "exactly one of path and remote"],
      ['remote = "b"\nupstream = "merge"', 'must be "keep" or "replace"'],
      ['remote = "b"\npacks = ["project:x"]', "cannot reference project-owned sources"],
      ['remote = "b"\nscopes = []', "unknown projects[0] key"],
    ]) {
      await put(join(f.source, "profiles", "bad.toml"), `harnesses = ["codex"]\ntemplate = "t"\n[[projects]]\n${entry}\n`);
      expect(() => loadProfileConfig(f.source, "bad")).toThrow(message);
    }
  });
});
