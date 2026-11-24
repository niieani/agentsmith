import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli, commitAll, projectFixture, put, run, skillMd, tree, type ProjectFixture } from "./support/project.ts";
import { EXCLUDE_BLOCK_END, EXCLUDE_BLOCK_START } from "../src/personal.ts";

/**
 * A project with shared inputs (project template and pack, a project skill) and personal ones (a Source Repository pack
 * and skill, and a project `*.local.md` snippet), with all three harnesses at the root and in `app`.
 */
async function layeredFixture(): Promise<ProjectFixture> {
  const f = await projectFixture("agentsmith-layers-");
  await put(join(f.source, "agentsmith.toml"), "");
  await put(join(f.source, "packs", "mine", "pack.toml"), 'skills = ["personal-skill"]\n');
  await put(join(f.source, "packs", "mine", "instructions", "notes", "10-mine.md"), "Personal note.\n");
  await put(join(f.source, "skills", "personal-skill", "SKILL.md"), skillMd("personal-skill"));
  await put(f.machine, `source = ${JSON.stringify(f.source)}\nprofile = "unused"\n`);
  await put(
    join(f.config, "config.toml"),
    [
      'harnesses = ["generic", "codex", "claude"]',
      "",
      "[[scopes]]",
      'path = "."',
      'template = "guide"',
      'packs = ["team", "mine"]',
      "",
      "[[scopes]]",
      'path = "app"',
      'template = "guide"',
      "packs = []",
      "",
    ].join("\n"),
  );
  await put(join(f.config, "templates", "guide", "default.md"), "# Guide\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(f.config, "packs", "team", "pack.toml"), 'skills = ["team-skill"]\n');
  await put(join(f.config, "packs", "team", "instructions", "notes", "10-team.md"), "Team note.\n");
  await put(join(f.config, "skills", "team-skill", "SKILL.md"), skillMd("team-skill"));
  await put(join(f.project, ".gitignore"), "/.agents/skills/*\n/.claude/skills/*\n*.local.md\n");
  await put(join(f.project, "app", "README.md"), "app\n");
  await commitAll(f, "fixture");
  // Claude's local settings are never committed.
  await put(
    join(f.project, ".claude", "settings.local.json"),
    `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, claudeMdExcludes: ["/elsewhere/CLAUDE.md"] }, null, 2)}\n`,
  );
  return f;
}

const settings = async (f: ProjectFixture) => JSON.parse(await readFile(join(f.project, ".claude", "settings.local.json"), "utf8"));

describe("shared and personal project layers", () => {
  test("commits a shared layer that personal inputs never change, and personal files Codex and Claude read instead", async () => {
    const f = await layeredFixture();
    const preview = await f.asmith("project", "diff");
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(`+ claudeMdExcludes in ${join(f.project, ".claude", "settings.local.json")}: ${join(f.project, "CLAUDE.md")}`);
    expect(preview.stdout).toContain(`: /AGENTS.override.md`);
    expect((await f.asmith("project", "explain")).stdout).toContain("layer: personal");
    const first = await f.asmith("project", "generate");
    expect(first.exitCode, first.stderr).toBe(0);
    expect((await f.asmith("project", "diff")).stdout).toBe("No changes.\n");

    // Shared layer: committed files from shared inputs only.
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe("# Guide\n\nTeam note.\n");
    expect(await readFile(join(f.project, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    // Personal layer: every input, read by Codex and Claude instead of the shared files.
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toBe("# Guide\n\nTeam note.\n\nPersonal note.\n");
    expect(await readFile(join(f.project, "CLAUDE.local.md"), "utf8")).toBe("@AGENTS.override.md\n");
    // Claude skips the shared CLAUDE.md; every other key and entry stays.
    expect(await settings(f)).toEqual({
      permissions: { allow: ["Bash(ls)"] },
      claudeMdExcludes: ["/elsewhere/CLAUDE.md", join(f.project, "CLAUDE.md")],
    });
    // The app scope has no personal input, so it has no personal files and no exclude.
    expect(existsSync(join(f.project, "app", "AGENTS.override.md"))).toBeFalse();
    expect(existsSync(join(f.project, "app", "CLAUDE.local.md"))).toBeFalse();
    // Skills are generated, never committed: shared and personal skills land in the same roots.
    for (const name of ["team-skill", "personal-skill"]) {
      expect(existsSync(join(f.project, ".agents", "skills", name, "SKILL.md"))).toBeTrue();
      expect(existsSync(join(f.project, ".claude", "skills", name, "SKILL.md"))).toBeTrue();
    }
    // Git sees only the shared layer; personal files are excluded through .git/info/exclude.
    const exclude = await readFile(join(f.project, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`\n${EXCLUDE_BLOCK_START}\n/AGENTS.override.md\n/CLAUDE.local.md\n/.claude/settings.local.json\n${EXCLUDE_BLOCK_END}\n`);
    expect((await f.git("status", "--porcelain")).split("\n").filter(Boolean).sort()).toEqual([
      "?? AGENTS.md",
      "?? CLAUDE.md",
      "?? app/AGENTS.md",
      "?? app/CLAUDE.md",
    ]);
    await commitAll(f, "shared layer");
    const shared = await tree(f.project, [".git", ".agents", ".claude", ".config", "AGENTS.override.md", "CLAUDE.local.md"]);

    // A new personal snippet changes only the personal layer.
    await put(join(f.config, "packs", "team", "instructions", "notes", "20-me.local.md"), "Local note.\n");
    const second = await f.asmith("project", "generate");
    expect(second.exitCode, second.stderr).toBe(0);
    expect(await tree(f.project, [".git", ".agents", ".claude", ".config", "AGENTS.override.md", "CLAUDE.local.md"])).toEqual(shared);
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toBe("# Guide\n\nTeam note.\n\nLocal note.\n\nPersonal note.\n");
    expect(await f.git("status", "--porcelain")).toBe("");

    // Without personal inputs, the personal files and the claudeMdExcludes entry go away. The exclude lines stay: every
    // worktree of the repository shares .git/info/exclude.
    await rm(join(f.config, "packs", "team", "instructions", "notes", "20-me.local.md"));
    await put(join(f.config, "config.toml"), (await readFile(join(f.config, "config.toml"), "utf8")).replace('packs = ["team", "mine"]', 'packs = ["team"]'));
    await commitAll(f, "drop personal pack");
    const third = await f.asmith("project", "generate");
    expect(third.exitCode, third.stderr).toBe(0);
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeFalse();
    expect(existsSync(join(f.project, "CLAUDE.local.md"))).toBeFalse();
    expect(existsSync(join(f.project, ".claude", "skills", "personal-skill"))).toBeFalse();
    expect(await settings(f)).toEqual({ permissions: { allow: ["Bash(ls)"] }, claudeMdExcludes: ["/elsewhere/CLAUDE.md"] });
    expect(await readFile(join(f.project, ".git", "info", "exclude"), "utf8")).toBe(exclude);
    expect(await f.git("status", "--porcelain")).toBe("");
  });

  test("personal Claude content without a personal AGENTS layer gets its own flat CLAUDE.local.md, and nested scopes work the same way", async () => {
    const f = await layeredFixture();
    await put(join(f.config, "config.toml"), (await readFile(join(f.config, "config.toml"), "utf8")).replace('packs = ["team", "mine"]', 'packs = ["team"]'));
    await put(join(f.config, "packs", "team", "instructions", "claude", "notes", "20-me.local.md"), "Claude only.\n");
    await put(join(f.config, "packs", "app", "instructions", "notes", "10-app.local.md"), "App note.\n");
    await put(
      join(f.config, "config.toml"),
      (await readFile(join(f.config, "config.toml"), "utf8")).replace(
        'path = "app"\ntemplate = "guide"\npacks = []',
        'path = "app"\ntemplate = "guide"\npacks = ["app"]',
      ),
    );
    const result = await f.asmith("project", "generate");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeFalse();
    expect(await readFile(join(f.project, "CLAUDE.local.md"), "utf8")).toBe("# Guide\n\nTeam note.\n\nClaude only.\n");
    expect(await readFile(join(f.project, "app", "AGENTS.md"), "utf8")).toBe("# Guide\n");
    expect(await readFile(join(f.project, "app", "AGENTS.override.md"), "utf8")).toBe("# Guide\n\nApp note.\n");
    expect(await readFile(join(f.project, "app", "CLAUDE.local.md"), "utf8")).toBe("@AGENTS.override.md\n");
    expect((await settings(f)).claudeMdExcludes).toEqual(["/elsewhere/CLAUDE.md", join(f.project, "CLAUDE.md"), join(f.project, "app", "CLAUDE.md")]);
    expect(await readFile(join(f.project, ".git", "info", "exclude"), "utf8")).toContain("/app/AGENTS.override.md\n");
  });

  test("an AGENTS.override.md agentsmith did not write is an error; its own is regenerated", async () => {
    const f = await layeredFixture();
    await put(join(f.project, "AGENTS.override.md"), "hand-written\n");
    const refused = await f.asmith("project", "generate");
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("codex-override-shadow");
    expect(refused.stderr).toContain("was not written by agentsmith");
    await rm(join(f.project, "AGENTS.override.md"));
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect((await f.asmith("project", "lint")).exitCode).toBe(0);
    await put(join(f.source, "packs", "mine", "instructions", "notes", "20-more.md"), "More.\n");
    const again = await f.asmith("project", "generate");
    expect(again.exitCode, again.stderr).toBe(0);
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toContain("More.");
  });

  test("a settings.local.json tracked by Git is refused, since agentsmith writes machine paths into it", async () => {
    const f = await layeredFixture();
    await f.git("add", "-f", ".claude/settings.local.json");
    await commitAll(f, "track settings");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("is tracked by Git");
    expect(existsSync(join(f.project, "AGENTS.md"))).toBeFalse();
  });

  test("an invalid settings.local.json stops generation before anything is written", async () => {
    const f = await layeredFixture();
    await writeFile(join(f.project, ".claude", "settings.local.json"), "{ not json");
    const result = await f.asmith("project", "generate");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("settings.local.json is not valid JSON");
    expect(existsSync(join(f.project, "AGENTS.md"))).toBeFalse();
  });

  test("clean removes personal files and claudeMdExcludes entries, keeps exclude lines, and removes a settings file left empty", async () => {
    const f = await layeredFixture();
    await rm(join(f.project, ".claude", "settings.local.json"));
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect((await settings(f)).claudeMdExcludes).toEqual([join(f.project, "CLAUDE.md")]);

    const dry = await f.asmith("project", "clean");
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(join(f.project, "AGENTS.override.md"));
    expect(dry.stdout).toContain(`claudeMdExcludes entry ${join(f.project, "CLAUDE.md")}`);
    expect(dry.stdout).toContain("keeps its agentsmith lines; every worktree shares that file");
    const before = await readFile(join(f.project, ".git", "info", "exclude"), "utf8");

    const cleaned = await f.asmith("project", "clean", "--yes");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    for (const path of ["AGENTS.md", "CLAUDE.md", "AGENTS.override.md", "CLAUDE.local.md", ".claude"]) expect(existsSync(join(f.project, path))).toBeFalse();
    expect(await readFile(join(f.project, ".git", "info", "exclude"), "utf8")).toBe(before);
    expect(await f.git("status", "--porcelain")).toBe("");
  });

  test("worktrees share .git/info/exclude, so cleaning one never un-ignores another's personal files", async () => {
    const f = await layeredFixture();
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    await commitAll(f, "shared layer");
    const other = join(f.root, "other");
    await f.git("worktree", "add", "-q", other);
    await put(join(other, ".claude", "settings.local.json"), "{}\n");
    const generated = await run(["bun", cli, "project", "generate"], other, f.env);
    expect(generated.exitCode, generated.stderr).toBe(0);
    expect(existsSync(join(other, "AGENTS.override.md"))).toBeTrue();

    const cleaned = await f.asmith("project", "clean", "--yes");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeFalse();
    // The other worktree's personal files stay ignored, and the block lists each entry once.
    expect((await run(["git", "status", "--porcelain"], other, f.env)).stdout).toBe("");
    const exclude = await readFile(join(f.project, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/AGENTS.override.md")).toHaveLength(1);
    expect(exclude.split("\n").filter((line) => line === EXCLUDE_BLOCK_START)).toHaveLength(1);
  });

  test("clean --scope keeps the other scopes' entries", async () => {
    const f = await layeredFixture();
    await put(join(f.config, "packs", "app", "instructions", "notes", "10-app.local.md"), "App note.\n");
    await put(
      join(f.config, "config.toml"),
      (await readFile(join(f.config, "config.toml"), "utf8")).replace(
        'path = "app"\ntemplate = "guide"\npacks = []',
        'path = "app"\ntemplate = "guide"\npacks = ["app"]',
      ),
    );
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    const result = await f.asmith("project", "clean", "--scope", "app", "--yes");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(f.project, "app", "AGENTS.override.md"))).toBeFalse();
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeTrue();
    expect((await settings(f)).claudeMdExcludes).toEqual(["/elsewhere/CLAUDE.md", join(f.project, "CLAUDE.md")]);
    const exclude = await readFile(join(f.project, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/app/AGENTS.override.md\n");
    expect(exclude).toContain("/AGENTS.override.md\n");
    expect(exclude).toContain("/.claude/settings.local.json\n");
    await mkdir(join(f.project, "app"), { recursive: true });
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(existsSync(join(f.project, "app", "AGENTS.override.md"))).toBeTrue();
  });

  test("a fresh clone without a machine config renders the shared layer and shared skills, skipping personal inputs with notices", async () => {
    const f = await layeredFixture();
    // A project skill whose required slot only the personal pack fills, and one with an optional slot.
    await put(join(f.config, "skills", "tracker", "SKILL.md"), `${skillMd("tracker")}\n<!-- agentsmith:required-slot tracker -->\n`);
    await put(join(f.config, "skills", "notes", "SKILL.md"), `${skillMd("notes")}\n<!-- agentsmith:slot tracker -->\n`);
    await put(join(f.config, "packs", "team", "pack.toml"), 'skills = ["team-skill", "tracker", "notes"]\n');
    await put(join(f.source, "packs", "mine", "skill-slots", "tracker", "10-mine.md"), "Use my tracker.\n");
    await put(join(f.source, "partials", "personal.md"), "Personal partial.\n");
    await put(
      join(f.config, "templates", "guide", "default.md"),
      "# Guide\n\n<!-- agentsmith:include source:personal.md -->\n\n<!-- agentsmith:slot notes -->\n",
    );
    await put(
      join(f.config, "config.toml"),
      (await readFile(join(f.config, "config.toml"), "utf8")).replace(
        'packs = ["team", "mine"]',
        'packs = ["team", "mine"]\nskills_enable = ["personal-skill"]',
      ),
    );

    // With the Source Repository, everything renders.
    const full = await f.asmith("project", "generate");
    expect(full.exitCode, full.stderr).toBe(0);
    expect(await readFile(join(f.project, ".agents", "skills", "tracker", "SKILL.md"), "utf8")).toContain("Use my tracker.");
    expect(await readFile(join(f.project, "AGENTS.override.md"), "utf8")).toContain("Personal partial.");
    const shared = await readFile(join(f.project, "AGENTS.md"), "utf8");
    expect(shared).toBe("# Guide\n\nTeam note.\n");
    await commitAll(f, "shared layer");

    // A fresh clone: same repository, no machine config.
    await rm(f.machine);
    const clone = await f.asmith("project", "generate");
    expect(clone.exitCode, clone.stderr).toBe(0);
    expect(clone.stderr).toContain('NOTICE personal-input-skipped: Skipped pack "mine"');
    expect(clone.stderr).toContain('NOTICE personal-input-skipped: Skipped skill "personal-skill"');
    expect(clone.stderr).toContain('NOTICE personal-input-skipped: Skipped partial "source:personal.md"');
    expect(clone.stderr).toContain("WARNING skill-skipped-required-slot: Skipped skill tracker");
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe(shared);
    expect(await readFile(join(f.project, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeFalse();
    expect(existsSync(join(f.project, "CLAUDE.local.md"))).toBeFalse();
    expect((await settings(f)).claudeMdExcludes).toEqual(["/elsewhere/CLAUDE.md"]);
    expect(existsSync(join(f.project, ".agents", "skills", "team-skill", "SKILL.md"))).toBeTrue();
    expect(existsSync(join(f.project, ".agents", "skills", "personal-skill"))).toBeFalse();
    expect(existsSync(join(f.project, ".agents", "skills", "tracker"))).toBeFalse();
    expect(await readFile(join(f.project, ".agents", "skills", "notes", "SKILL.md"), "utf8")).toBe(skillMd("notes"));
    // The settings file stays ignored: the exclude line the first generation added is never removed.
    expect(await f.git("status", "--porcelain")).toBe("");

    // Notices never fail a lint, even with --warnings-as-errors; the skipped-skill warning does.
    const lint = await f.asmith("project", "lint", "--warnings-as-errors");
    expect(lint.exitCode).toBe(2);
    expect(lint.stderr).toContain("skill-skipped-required-slot");
    expect(lint.stderr).not.toMatch(/^NOTICE.*\n.*ERROR/m);
  });

  test("a project-qualified source stays an error without a Source Repository", async () => {
    const f = await layeredFixture();
    await rm(f.machine);
    await put(
      join(f.config, "config.toml"),
      (await readFile(join(f.config, "config.toml"), "utf8")).replace('packs = ["team", "mine"]', 'packs = ["team", "project:missing"]'),
    );
    const result = await f.asmith("project", "generate");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('missing pack source "project:missing"');
  });

  test("exclusive mode treats generated skills, placeholders, and personal files as managed", async () => {
    const f = await layeredFixture();
    await put(join(f.config, "config.toml"), `exclusive = true\n${await readFile(join(f.config, "config.toml"), "utf8")}`);
    await put(join(f.project, ".claude", "skills", ".gitkeep"), "");
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    const lint = await f.asmith("project", "lint");
    expect(lint.exitCode, lint.stderr).toBe(0);
    await put(join(f.project, ".claude", "skills", "stray", "SKILL.md"), skillMd("stray"));
    const stray = await f.asmith("project", "lint");
    expect(stray.exitCode).toBe(5);
    expect(stray.stderr).toContain(join(f.project, ".claude", "skills", "stray"));
  });
});
