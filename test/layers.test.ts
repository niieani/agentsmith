import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, projectFixture, put, skillMd, tree, type ProjectFixture } from "./support/project.ts";

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
    const first = await f.asmith("project", "generate");
    expect(first.exitCode, first.stderr).toBe(0);

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
    expect(exclude).toContain("\n/AGENTS.override.md\n/CLAUDE.local.md\n/.claude/settings.local.json\n");
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

    // Without personal inputs, the personal files, their exclude lines, and the claudeMdExcludes entry go away.
    await rm(join(f.config, "packs", "team", "instructions", "notes", "20-me.local.md"));
    await put(join(f.config, "config.toml"), (await readFile(join(f.config, "config.toml"), "utf8")).replace('packs = ["team", "mine"]', 'packs = ["team"]'));
    await commitAll(f, "drop personal pack");
    const third = await f.asmith("project", "generate");
    expect(third.exitCode, third.stderr).toBe(0);
    expect(existsSync(join(f.project, "AGENTS.override.md"))).toBeFalse();
    expect(existsSync(join(f.project, "CLAUDE.local.md"))).toBeFalse();
    expect(existsSync(join(f.project, ".claude", "skills", "personal-skill"))).toBeFalse();
    expect(await settings(f)).toEqual({ permissions: { allow: ["Bash(ls)"] }, claudeMdExcludes: ["/elsewhere/CLAUDE.md"] });
    const after = await readFile(join(f.project, ".git", "info", "exclude"), "utf8");
    expect(after).not.toContain("AGENTS.override.md");
    expect(after).not.toContain("settings.local.json");
    // The user's own settings file is back to how Git saw it before agentsmith.
    expect(await f.git("status", "--porcelain")).toBe("?? .claude/\n");
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

  test("clean removes personal files, their exclude lines, and claudeMdExcludes entries; a settings file left empty goes too", async () => {
    const f = await layeredFixture();
    await rm(join(f.project, ".claude", "settings.local.json"));
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect((await settings(f)).claudeMdExcludes).toEqual([join(f.project, "CLAUDE.md")]);

    const dry = await f.asmith("project", "clean");
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(join(f.project, "AGENTS.override.md"));
    expect(dry.stdout).toContain(`claudeMdExcludes entry ${join(f.project, "CLAUDE.md")}`);
    expect(dry.stdout).toContain("/CLAUDE.local.md in ");

    const cleaned = await f.asmith("project", "clean", "--yes");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    for (const path of ["AGENTS.md", "CLAUDE.md", "AGENTS.override.md", "CLAUDE.local.md", ".claude"]) expect(existsSync(join(f.project, path))).toBeFalse();
    const exclude = await readFile(join(f.project, ".git", "info", "exclude"), "utf8");
    for (const entry of ["/AGENTS.override.md", "/CLAUDE.local.md", "/.claude/settings.local.json"]) expect(exclude).not.toContain(entry);
    expect(await f.git("status", "--porcelain")).toBe("");
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
    expect(exclude).not.toContain("/app/AGENTS.override.md");
    expect(exclude).toContain("/AGENTS.override.md\n");
    expect(exclude).toContain("/.claude/settings.local.json\n");
    await mkdir(join(f.project, "app"), { recursive: true });
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(existsSync(join(f.project, "app", "AGENTS.override.md"))).toBeTrue();
  });
});
