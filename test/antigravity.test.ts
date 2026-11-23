import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, commitAll, projectFixture, put, run, skillMd, tree, type ProjectFixture } from "./support/project.ts";

const FRONT_MATTER = "---\ntrigger: always_on\n---\n\n";
const INTRO = "These personal instructions extend AGENTS.md and take precedence over it where they conflict.";

/**
 * A Source Repository selecting `generic` and `antigravity`, cloned into a Sandbox Home whose machine config is outside
 * the real home. The template has an Antigravity variant, and the pack carries Antigravity instruction and skill
 * snippets.
 */
async function globalFixture(profile: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-antigravity-"));
  const realHome = join(root, "real-home");
  const home = join(root, "home");
  const seed = join(root, "seed");
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  await mkdir(home, { recursive: true });
  await put(join(realHome, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.test\n[init]\n\tdefaultBranch = main\n");
  const env = { ...Bun.env, HOME: realHome, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined, GIT_CONFIG_GLOBAL: undefined };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run(["git", ...args], cwd, env);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  await mkdir(seed, { recursive: true });
  await git(root, "init", "--bare", remote);
  await git(seed, "init");
  await put(join(seed, ".gitignore"), "*.local.md\n");
  await put(join(seed, "agentsmith.toml"), "");
  await put(
    join(seed, "profiles", "test.toml"),
    ['harnesses = ["generic", "antigravity"]', 'template = "base"', 'packs = ["base"]', ...profile, ""].join("\n"),
  );
  await put(join(seed, "templates", "base", "default.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(seed, "templates", "base", "antigravity.md"), "# Antigravity\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(seed, "packs", "base", "pack.toml"), 'skills = ["review"]\n');
  await put(join(seed, "packs", "base", "instructions", "notes", "10-shared.md"), "Shared note.\n");
  await put(join(seed, "packs", "base", "instructions", "antigravity", "notes", "20-agy.md"), "Antigravity note.\n");
  await put(join(seed, "packs", "base", "skill-slots", "harnesses", "antigravity", "detail", "10-agy.md"), "Antigravity detail.\n");
  await put(join(seed, "skills", "review", "SKILL.md"), skillMd("review", "Review.\n\n<!-- agentsmith:slot detail -->"));
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "source");
  await git(seed, "push", "-u", remote, "HEAD:main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", remote, source);
  const config = join(root, "config.toml");
  await put(config, `source = "source"\nprofile = "test"\nhome = "home"\n`);
  const asmith = (...args: string[]) => run(["bun", cli, ...args, "--config", config], root, env);
  const rule = join(home, ".gemini", "config", "rules", "agentsmith.md");
  return { root, realHome, home, source, config, git, asmith, rule };
}

describe("antigravity global scope", () => {
  test("writes an always-on rule and its own skill root inside the sandbox home", async () => {
    const f = await globalFixture();
    const generated = await f.asmith("global", "generate");
    expect(generated.exitCode, generated.stderr).toBe(0);
    expect(await readFile(f.rule, "utf8")).toBe(`${FRONT_MATTER}# Antigravity\n\nShared note.\n\nAntigravity note.\n`);
    // Antigravity does not read ~/.agents/skills, so it gets its own copy, which alone carries its content.
    expect(await readFile(join(f.home, ".gemini", "config", "skills", "review", "SKILL.md"), "utf8")).toBe(skillMd("review", "Review.\n\nAntigravity detail."));
    expect(await readFile(join(f.home, ".agents", "skills", "review", "SKILL.md"), "utf8")).toBe(skillMd("review", "Review."));
    // No global instruction file for generic; nothing in the real home.
    expect(existsSync(join(f.home, ".agents", "AGENTS.md"))).toBeFalse();
    expect(existsSync(join(f.realHome, ".gemini"))).toBeFalse();

    const status = await f.asmith("global", "status");
    expect(status.exitCode, status.stderr).toBe(0);
    expect((await f.asmith("global", "diff")).stdout).toBe("No changes.\n");

    const dry = await f.asmith("global", "clean");
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(f.rule);
    const cleaned = await f.asmith("global", "clean", "-y");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect(existsSync(f.rule)).toBeFalse();
    expect(existsSync(join(f.home, ".gemini"))).toBeFalse();
  });

  test("adopts edits around the generated rule and keeps its front matter first", async () => {
    const f = await globalFixture();
    expect((await f.asmith("global", "generate")).exitCode).toBe(0);
    const generated = await readFile(f.rule, "utf8");
    const edited = `${FRONT_MATTER}Machine preface.\n\n${generated.slice(FRONT_MATTER.length)}\nMachine appendix.\n`;
    await writeFile(f.rule, edited);
    expect((await f.asmith("global", "generate")).exitCode).toBe(5);

    const adopted = await f.asmith("global", "adopt");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    const instructions = join(f.source, "packs", "base", "instructions", "antigravity");
    expect(await readFile(join(instructions, "prepend", "00-adopted.local.md"), "utf8")).toBe("Machine preface.\n\n");
    expect(await readFile(join(instructions, "append", "99-adopted.local.md"), "utf8")).toBe("\nMachine appendix.\n");
    expect(await readFile(f.rule, "utf8")).toBe(edited);
    expect((await f.asmith("global", "generate")).exitCode).toBe(0);
    expect(await readFile(f.rule, "utf8")).toBe(edited);

    // Text before the front matter is not an edit around the generated content.
    await writeFile(f.rule, `Above.\n${edited}`);
    const refused = await f.asmith("global", "adopt");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain("not strictly before or after");
  });

  test("exclusive mode covers both global Antigravity skill roots", async () => {
    const f = await globalFixture(["exclusive = true", 'exclusive_allow = ["kept-*"]']);
    await put(join(f.home, ".gemini", "skills", "foreign", "SKILL.md"), skillMd("foreign"));
    await put(join(f.home, ".gemini", "config", "skills", "kept-one", "SKILL.md"), skillMd("kept-one"));
    const refused = await f.asmith("global", "generate");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(join(f.home, ".gemini", "skills", "foreign"));
    expect(refused.stderr).not.toContain("kept-one");
    const backedUp = await f.asmith("global", "generate", "--on-modified=backup");
    expect(backedUp.exitCode, backedUp.stderr).toBe(0);
    expect(existsSync(join(f.home, ".gemini", "skills", "foreign"))).toBeFalse();
    expect(existsSync(join(f.home, ".gemini", "config", "skills", "kept-one"))).toBeTrue();
  });

  test("a same-named unmanaged skill in ~/.gemini/skills collides with a planned one", async () => {
    const f = await globalFixture();
    await put(join(f.home, ".gemini", "skills", "review", "SKILL.md"), skillMd("review"));
    const lint = await f.asmith("global", "lint");
    expect(lint.exitCode).not.toBe(0);
    expect(lint.stdout + lint.stderr).toContain("planned-unmanaged-skill-collision");
  });
});

/**
 * A project selecting Codex and Antigravity with a shared template and pack, plus a personal `*.local.md` snippet in a
 * slot under the `## Style` heading.
 */
async function layeredProject(harnesses = ["codex", "antigravity"], extra: string[] = []): Promise<ProjectFixture> {
  const f = await projectFixture("agentsmith-antigravity-project-");
  await put(
    join(f.config, "config.toml"),
    [
      ...extra,
      `harnesses = [${harnesses.map((item) => JSON.stringify(item)).join(", ")}]`,
      "",
      "[[scopes]]",
      'path = "."',
      'template = "guide"',
      'packs = ["team"]',
      "",
    ].join("\n"),
  );
  await put(
    join(f.config, "templates", "guide", "default.md"),
    "# Guide\n\n## Notes\n\n<!-- agentsmith:slot notes -->\n\n## Style\n\n<!-- agentsmith:slot style -->\n",
  );
  await put(join(f.config, "packs", "team", "pack.toml"), 'skills = ["team-skill"]\n');
  await put(join(f.config, "packs", "team", "instructions", "notes", "10-team.md"), "Team note.\n");
  await put(join(f.config, "packs", "team", "instructions", "style", "10-team.md"), "Team style.\n");
  await put(join(f.config, "skills", "team-skill", "SKILL.md"), skillMd("team-skill", "Team.\n\n<!-- agentsmith:slot detail -->"));
  await put(join(f.project, ".gitignore"), "/.agents/skills/*\n/.agent/skills/\n*.local.md\n");
  await commitAll(f, "fixture");
  return f;
}

const personalRule = (f: ProjectFixture, scope = ".") => join(f.project, scope, ".agents", "rules", "agentsmith-personal.md");

describe("antigravity project scope", () => {
  test("shares AGENTS.md and adds personal snippets as an excluded always-on rule", async () => {
    const f = await layeredProject();
    const first = await f.asmith("project", "generate");
    expect(first.exitCode, first.stderr).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe("# Guide\n\n## Notes\n\nTeam note.\n\n## Style\n\nTeam style.\n");
    expect(existsSync(join(f.project, "GEMINI.md"))).toBeFalse();
    // Only shared inputs: no personal files at all.
    expect(existsSync(personalRule(f))).toBeFalse();
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeFalse();
    expect(await readFile(join(f.project, ".agents", "skills", "team-skill", "SKILL.md"), "utf8")).toBe(skillMd("team-skill", "Team."));

    await put(join(f.config, "packs", "team", "instructions", "style", "20-mine.local.md"), "My style.\n");
    await put(join(f.config, "packs", "team", "instructions", "prepend", "00-mine.local.md"), "My preface.\n");
    const second = await f.asmith("project", "generate");
    expect(second.exitCode, second.stderr).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe("# Guide\n\n## Notes\n\nTeam note.\n\n## Style\n\nTeam style.\n");
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toBe(
      "My preface.\n# Guide\n\n## Notes\n\nTeam note.\n\n## Style\n\nTeam style.\n\nMy style.\n",
    );
    expect(await readFile(personalRule(f), "utf8")).toBe(`${FRONT_MATTER}${INTRO}\n\nMy preface.\n\n## Style\n\nMy style.\n`);
    expect(await readFile(join(f.project, ".git", "info", "exclude"), "utf8")).toContain("/.agents/rules/agentsmith-personal.md\n");
    // Only the shared AGENTS.md is left to commit.
    expect(await f.git("status", "--porcelain")).toBe("?? AGENTS.md\n");
    expect((await f.asmith("project", "diff")).stdout).toBe("No changes.\n");
    expect((await f.asmith("project", "explain")).stdout).toContain(`antigravity .: instruction layer\n  destination: ${personalRule(f)}\n  layer: personal`);

    // Without personal snippets the rule goes away.
    await rm(join(f.config, "packs", "team", "instructions", "style", "20-mine.local.md"));
    await rm(join(f.config, "packs", "team", "instructions", "prepend", "00-mine.local.md"));
    const third = await f.asmith("project", "generate");
    expect(third.exitCode, third.stderr).toBe(0);
    expect(existsSync(personalRule(f))).toBeFalse();
  });

  test("clean removes the personal rule", async () => {
    const f = await layeredProject();
    await put(join(f.config, "packs", "team", "instructions", "notes", "20-mine.local.md"), "My note.\n");
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(await readFile(personalRule(f), "utf8")).toBe(`${FRONT_MATTER}${INTRO}\n\n## Notes\n\nMy note.\n`);
    const cleaned = await f.asmith("project", "clean", "-y");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect(existsSync(personalRule(f))).toBeFalse();
    expect(existsSync(join(f.project, ".agents", "rules"))).toBeFalse();
  });

  test("rejects Antigravity-specific instruction snippets in a project", async () => {
    const f = await layeredProject(["antigravity"]);
    await put(join(f.config, "templates", "guide", "antigravity.md"), "# Unused variant\n");
    await put(join(f.config, "packs", "team", "instructions", "antigravity", "notes", "20-agy.md"), "Agy note.\n");
    const lint = await f.asmith("project", "lint");
    expect(lint.exitCode).not.toBe(0);
    expect(lint.stdout + lint.stderr).toContain("harness-instruction-content-project");
    await rm(join(f.config, "packs", "team", "instructions", "antigravity"), { recursive: true });
    // The Antigravity template variant never renders into the shared AGENTS.md.
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toStartWith("# Guide\n");
  });

  test("an Antigravity skill snippet puts the skill's Antigravity copy in .agent/skills, which wins over .agents/skills", async () => {
    const f = await layeredProject(["generic", "codex", "antigravity"]);
    await put(join(f.config, "packs", "team", "skill-slots", "harnesses", "antigravity", "detail", "10-agy.md"), "Antigravity detail.\n");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(join(f.project, ".agent", "skills", "team-skill", "SKILL.md"), "utf8")).toBe(skillMd("team-skill", "Team.\n\nAntigravity detail."));
    expect(await readFile(join(f.project, ".agents", "skills", "team-skill", "SKILL.md"), "utf8")).toBe(skillMd("team-skill", "Team."));
    expect(result.stderr).not.toContain("collision");
    expect(await f.git("status", "--porcelain")).not.toContain(".agent/");

    // Dropping the snippet removes the .agent/skills copy.
    await rm(join(f.config, "packs", "team", "skill-slots"), { recursive: true });
    const second = await f.asmith("project", "generate");
    expect(second.exitCode, second.stderr).toBe(0);
    expect(existsSync(join(f.project, ".agent", "skills", "team-skill"))).toBeFalse();
  });

  test("an unmanaged skill in an Antigravity-only root collides, and exclusive mode reports it", async () => {
    const f = await layeredProject(["antigravity"]);
    await put(join(f.project, "_agents", "skills", "team-skill", "SKILL.md"), skillMd("team-skill"));
    const lint = await f.asmith("project", "lint");
    expect(lint.exitCode).not.toBe(0);
    expect(lint.stdout + lint.stderr).toContain("planned-unmanaged-skill-collision");
    await rm(join(f.project, "_agents"), { recursive: true });

    await put(join(f.config, "config.toml"), (await readFile(join(f.config, "config.toml"), "utf8")).replace("harnesses", "exclusive = true\nharnesses"));
    await put(join(f.project, ".agent", "skills", "foreign", "SKILL.md"), skillMd("foreign"));
    const refused = await f.asmith("project", "generate");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(join(f.project, ".agent", "skills", "foreign"));
  });

  test("warns about a GEMINI.md beside AGENTS.md", async () => {
    const f = await layeredProject(["antigravity"]);
    await put(join(f.project, "GEMINI.md"), "# Gemini\n");
    const lint = await f.asmith("project", "lint");
    expect(lint.stdout + lint.stderr).toContain("gemini-md-beside-agents-md");
    const codexOnly = await layeredProject(["codex"]);
    await put(join(codexOnly.project, "GEMINI.md"), "# Gemini\n");
    expect((await codexOnly.asmith("project", "lint")).stdout).not.toContain("gemini-md-beside-agents-md");
  });

  test("project init detects Antigravity and ignores its skill roots", async () => {
    const f = await projectFixture("agentsmith-antigravity-init-");
    await put(join(f.project, "GEMINI.md"), "# Gemini\n");
    const init = await f.asmith("project", "init");
    expect(init.exitCode, init.stderr).toBe(0);
    expect(await readFile(join(f.config, "config.toml"), "utf8")).toContain('harnesses = ["antigravity"]');
    const ignore = await readFile(join(f.project, ".gitignore"), "utf8");
    for (const line of ["/.agents/skills/*", "!/.agents/skills/.gitkeep", "/.agent/skills/"]) expect(ignore).toContain(`${line}\n`);
    expect(existsSync(join(f.project, ".agents", "skills", ".gitkeep"))).toBeTrue();
  });
});

describe("antigravity in a third-party repository", () => {
  async function upstream(mode: "keep" | "replace"): Promise<ProjectFixture> {
    const f = await projectFixture("agentsmith-antigravity-upstream-");
    await put(join(f.project, "AGENTS.md"), "# Upstream\n\nUpstream rules.\n");
    await commitAll(f, "upstream");
    await put(join(f.source, "agentsmith.toml"), "");
    await put(join(f.source, "profiles", "me.toml"), ['harnesses = ["antigravity"]', 'template = "mine"', ""].join("\n"));
    await put(join(f.source, "templates", "mine", "default.md"), "# Mine\n\n<!-- agentsmith:slot notes -->\n");
    await put(join(f.source, "packs", "mine", "pack.toml"), "skills = []\n");
    await put(join(f.source, "packs", "mine", "instructions", "notes", "10-mine.md"), "My note.\n");
    await put(f.machine, `source = ${JSON.stringify(f.source)}\nprofile = "me"\n`);
    await put(
      join(f.config, "config.toml"),
      [`upstream = "${mode}"`, 'harnesses = ["antigravity"]', "", "[[scopes]]", 'path = "."', 'template = "mine"', 'packs = ["mine"]', ""].join("\n"),
    );
    return f;
  }

  test("keep adds the whole personal layer as a rule beside the upstream AGENTS.md", async () => {
    const f = await upstream("keep");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("upstream-replace-cumulative");
    expect(await readFile(personalRule(f), "utf8")).toBe(`${FRONT_MATTER}${INTRO}\n\n# Mine\n\nMy note.\n`);
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe("# Upstream\n\nUpstream rules.\n");
    expect(await f.git("status", "--porcelain")).toBe("");
    expect(Object.keys(await tree(f.project, [".git", ".config"])).sort()).toEqual([".agents/rules/agentsmith-personal.md", "AGENTS.md"]);
  });

  test("replace warns that Antigravity still reads the upstream files", async () => {
    const f = await upstream("replace");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("upstream-replace-cumulative");
    expect(existsSync(personalRule(f))).toBeTrue();
  });
});
