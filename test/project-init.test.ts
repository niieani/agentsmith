import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { addDevDependency, detectHarnesses, detectPackageManager, ignoreEntries, runAsmith } from "../src/project-init.ts";
import { cli, commitAll, projectFixture, put, run, skillMd, type ProjectFixture } from "./support/project.ts";

/** Fake package managers on PATH: each logs its arguments and adds asmith to devDependencies like the real one. */
async function fakePackageManagers(f: ProjectFixture): Promise<{ env: Record<string, string | undefined>; log: string }> {
  const bin = join(f.root, "fake-bin");
  const log = join(f.root, "pm.log");
  await mkdir(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    `echo "$(basename "$0") $*" >> ${JSON.stringify(log)}`,
    `${JSON.stringify(process.execPath)} -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.devDependencies={...p.devDependencies,asmith:"^0.3.0"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")'`,
    "",
  ].join("\n");
  for (const name of ["bun", "npm", "pnpm", "yarn"]) {
    await put(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  return { env: { ...f.env, PATH: `${bin}:${f.env.PATH ?? ""}` }, log };
}

describe("project init", () => {
  test("writes a config for the harnesses present, ignore entries, and skill folder placeholders, idempotently", async () => {
    const f = await projectFixture("agentsmith-init-");
    await put(join(f.project, ".claude", "skills", "authors-skill", "SKILL.md"), skillMd("authors-skill"));
    await put(join(f.project, ".gitignore"), "node_modules\n");
    await commitAll(f, "existing");
    const first = await f.asmith("project", "init");
    expect(first.exitCode, first.stderr).toBe(0);
    const config = await readFile(join(f.config, "config.toml"), "utf8");
    expect(config).toContain('harnesses = ["claude"]');
    expect(await readFile(join(f.project, ".gitignore"), "utf8")).toBe(
      "node_modules\n\n# agentsmith: generated skills and personal snippets\n/.claude/skills/*\n!/.claude/skills/.gitkeep\n/.config/agentsmith/**/*.local.md\n",
    );
    expect(existsSync(join(f.project, ".claude", "skills", ".gitkeep"))).toBeTrue();
    expect(first.stderr).toContain("WARNING committed-skill: .claude/skills/authors-skill is committed");
    // The config generates as written, and the placeholder is the only new file Git sees in the skill root.
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect((await f.git("status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).sort()).toEqual([
      " M .gitignore",
      "?? .claude/skills/.gitkeep",
      "?? .config/agentsmith/config.toml",
    ]);
    await put(join(f.project, ".claude", "skills", "generated", "SKILL.md"), skillMd("generated"));
    expect(await f.git("status", "--porcelain", "--", ".claude/skills/generated")).toBe("");

    const before = { config, gitignore: await readFile(join(f.project, ".gitignore"), "utf8") };
    const second = await f.asmith("project", "init");
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toContain("already exists; left unchanged");
    expect(await readFile(join(f.config, "config.toml"), "utf8")).toBe(before.config);
    expect(await readFile(join(f.project, ".gitignore"), "utf8")).toBe(before.gitignore);
  });

  test("--prepare adds asmith with the detected package manager and a prepare script, and is idempotent", async () => {
    const f = await projectFixture("agentsmith-init-prepare-");
    await put(join(f.project, "package.json"), `${JSON.stringify({ name: "app", packageManager: "pnpm@9.1.0", scripts: { test: "vitest" } }, null, 4)}\n`);
    await put(join(f.project, "yarn.lock"), "");
    await commitAll(f, "app");
    const pm = await fakePackageManagers(f);
    const init = () => run([process.execPath, cli, "project", "init", "--prepare"], f.project, pm.env);
    const first = await init();
    expect(first.exitCode, first.stderr).toBe(0);
    expect(await readFile(pm.log, "utf8")).toBe("pnpm add -D asmith\n");
    const manifest = await readFile(join(f.project, "package.json"), "utf8");
    expect(JSON.parse(manifest).scripts).toEqual({ test: "vitest", prepare: "asmith project generate" });
    expect(first.stdout).toContain("run pnpm exec asmith project generate");
    expect(existsSync(join(f.config, "config.toml"))).toBeTrue();

    const second = await init();
    expect(second.exitCode, second.stderr).toBe(0);
    expect(await readFile(pm.log, "utf8")).toBe("pnpm add -D asmith\n");
    expect(await readFile(join(f.project, "package.json"), "utf8")).toBe(manifest);
    expect(second.stdout).toContain("scripts.prepare already runs asmith project generate");
  });

  test("--prepare keeps a foreign prepare script and prints the chained command", async () => {
    const f = await projectFixture("agentsmith-init-foreign-");
    await put(join(f.project, "package.json"), `${JSON.stringify({ name: "app", scripts: { prepare: "husky" } }, null, 2)}\n`);
    await put(join(f.project, "bun.lock"), "");
    await commitAll(f, "app");
    const pm = await fakePackageManagers(f);
    const result = await run([process.execPath, cli, "project", "init", "--prepare"], f.project, pm.env);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(pm.log, "utf8")).toBe("bun add -d asmith\n");
    expect(JSON.parse(await readFile(join(f.project, "package.json"), "utf8")).scripts).toEqual({ prepare: "husky" });
    expect(result.stderr).toContain("WARNING prepare-script-kept");
    expect(result.stderr).toContain('"prepare": "husky && asmith project generate"');
    expect(result.stdout).toContain("run bunx asmith project generate");
  });

  test("--prepare needs a package.json, and init needs a Git repository", async () => {
    const f = await projectFixture("agentsmith-init-errors-");
    const prepare = await f.asmith("project", "init", "--prepare");
    expect(prepare.exitCode).toBe(2);
    expect(prepare.stderr).toContain("--prepare needs a package.json");
    const outside = await run(["bun", cli, "project", "init"], f.root, f.env);
    expect(outside.exitCode).toBe(2);
    expect(outside.stderr).toContain("project init needs a Git repository");
  });
});

describe("project init helpers", () => {
  test("detects the package manager from packageManager, then lockfiles, then npm", async () => {
    const f = await projectFixture("agentsmith-pm-");
    expect(detectPackageManager(f.project, {})).toBe("npm");
    expect(detectPackageManager(f.project, { packageManager: "yarn@4.1.0" })).toBe("yarn");
    for (const [file, manager] of [
      ["package-lock.json", "npm"],
      ["yarn.lock", "yarn"],
      ["pnpm-lock.yaml", "pnpm"],
      ["bun.lockb", "bun"],
    ] as const) {
      await put(join(f.project, file), "");
      expect(detectPackageManager(f.project, { packageManager: "unknown@1" })).toBe(manager);
    }
    expect(detectPackageManager(f.project, { packageManager: "npm@10.0.0" })).toBe("npm");
  });

  test("names each package manager's commands", () => {
    expect(addDevDependency("npm")).toEqual(["npm", "install", "-D", "asmith"]);
    expect(addDevDependency("bun")).toEqual(["bun", "add", "-d", "asmith"]);
    expect([runAsmith("bun", true), runAsmith("pnpm", true), runAsmith("yarn", true), runAsmith("npm", true)]).toEqual([
      "bunx asmith",
      "pnpm exec asmith",
      "yarn asmith",
      "npx asmith",
    ]);
    expect(runAsmith("pnpm", false)).toBe("pnpm dlx asmith");
  });

  test("ignores each selected harness's skill root and personal snippets", async () => {
    expect(ignoreEntries(["generic", "codex", "claude"])).toEqual([
      "/.agents/skills/*",
      "!/.agents/skills/.gitkeep",
      "/.codex/skills/*",
      "!/.codex/skills/.gitkeep",
      "/.claude/skills/*",
      "!/.claude/skills/.gitkeep",
      "/.config/agentsmith/**/*.local.md",
    ]);
    expect(ignoreEntries(["antigravity"])).toEqual(["/.agents/skills/*", "!/.agents/skills/.gitkeep", "/.agent/skills/", "/.config/agentsmith/**/*.local.md"]);
    const f = await projectFixture("agentsmith-detect-");
    expect(detectHarnesses(f.project)).toEqual(["generic", "codex", "claude", "antigravity"]);
    await mkdir(join(f.project, ".codex"));
    await mkdir(join(f.project, ".agents"));
    expect(detectHarnesses(f.project)).toEqual(["generic", "codex"]);
    await put(join(f.project, "GEMINI.md"), "# Gemini\n");
    expect(detectHarnesses(f.project)).toEqual(["generic", "codex", "antigravity"]);
  });

  test("detects Antigravity from its .agent directory", async () => {
    const f = await projectFixture("agentsmith-detect-agy-");
    await mkdir(join(f.project, ".agent"));
    expect(detectHarnesses(f.project)).toEqual(["antigravity"]);
  });
});

/** A Source Repository with a template family `team` that includes partials, one of them through another. */
async function sourceTemplateFixture(): Promise<ProjectFixture> {
  const f = await projectFixture("agentsmith-init-template-");
  await put(join(f.source, "agentsmith.toml"), "");
  await put(
    join(f.source, "templates", "team", "default.md"),
    "# Team\n\n<!-- agentsmith:include source:team/rules.md -->\n\n```md\n<!-- agentsmith:include source:not/copied.md -->\n```\n\n<!-- agentsmith:slot notes -->\n",
  );
  await put(join(f.source, "templates", "team", "claude.md"), "# Team\n\n<!-- agentsmith:include team/rules.md -->\n\nClaude only.\n");
  await put(join(f.source, "templates", "other", "default.md"), "# Other\n");
  await put(join(f.source, "partials", "team", "rules.md"), "# Rules\n\nBe kind.\n\n<!-- agentsmith:include team/more.md -->\n");
  await put(join(f.source, "partials", "team", "more.md"), "More.\n");
  await put(join(f.source, "partials", "unused.md"), "Unused.\n");
  await put(f.machine, `source = ${JSON.stringify(f.source)}\nprofile = "unused"\n`);
  await commitAll(f, "empty");
  return f;
}

describe("project init --template", () => {
  test("copies every variant of a Source Repository template and the partials it includes, and the shared layer renders the copy", async () => {
    const f = await sourceTemplateFixture();
    const first = await f.asmith("project", "init", "--template", "team");
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain(
      [
        "Copied from the Source Repository:",
        "  .config/agentsmith/templates/team/claude.md",
        "  .config/agentsmith/templates/team/default.md",
        "  .config/agentsmith/partials/team/rules.md",
        "  .config/agentsmith/partials/team/more.md",
      ].join("\n"),
    );
    expect(await readFile(join(f.config, "config.toml"), "utf8")).toContain('path = "."\ntemplate = "project:team"\npacks = []\n');
    // source: includes now name the project copy; includes inside code fences are text and stay as written.
    expect(await readFile(join(f.config, "templates", "team", "default.md"), "utf8")).toBe(
      "# Team\n\n<!-- agentsmith:include project:team/rules.md -->\n\n```md\n<!-- agentsmith:include source:not/copied.md -->\n```\n\n<!-- agentsmith:slot notes -->\n",
    );
    expect(await readFile(join(f.config, "templates", "team", "claude.md"), "utf8")).toBe(
      await readFile(join(f.source, "templates", "team", "claude.md"), "utf8"),
    );
    expect(existsSync(join(f.config, "partials", "unused.md"))).toBeFalse();
    expect(existsSync(join(f.config, "templates", "other"))).toBeFalse();

    // Rerunning changes nothing.
    const again = await f.asmith("project", "init", "--template", "team");
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stdout).toContain("The project already has project:team; nothing copied.");

    // A fresh clone without a machine config renders the committed shared layer from the copy.
    await rm(f.machine);
    const generated = await f.asmith("project", "generate");
    expect(generated.exitCode, generated.stderr).toBe(0);
    expect(generated.stderr).not.toContain("personal-input-skipped");
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe(
      "# Team\n\n## Rules\n\nBe kind.\n\nMore.\n\n```md\n<!-- agentsmith:include source:not/copied.md -->\n```\n",
    );
    expect(await readFile(join(f.project, "CLAUDE.md"), "utf8")).toBe("# Team\n\n## Rules\n\nBe kind.\n\nMore.\n\nClaude only.\n");
  });

  test("never overwrites a project file that differs, and writes nothing then", async () => {
    const f = await sourceTemplateFixture();
    await put(join(f.config, "templates", "team", "codex.md"), "Unrelated, kept.\n");
    await put(join(f.config, "templates", "team", "default.md"), "My own.\n");
    const refused = await f.asmith("project", "init", "--template", "team");
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("never overwrites project files");
    expect(refused.stderr).toContain("  .config/agentsmith/templates/team/default.md");
    expect(existsSync(join(f.config, "config.toml"))).toBeFalse();
    expect(existsSync(join(f.config, "templates", "team", "claude.md"))).toBeFalse();
    expect(existsSync(join(f.config, "partials"))).toBeFalse();
    expect(existsSync(join(f.project, ".gitignore"))).toBeFalse();
  });

  test("an unqualified include the project already provides is not copied", async () => {
    const f = await sourceTemplateFixture();
    await put(join(f.config, "partials", "team", "rules.md"), "# Rules\n\nProject rules.\n");
    // The source: include in default.md still needs the Source Repository's rules.md, which differs.
    const refused = await f.asmith("project", "init", "--template", "team");
    expect(refused.exitCode).toBe(2);
    await put(join(f.source, "templates", "team", "default.md"), "# Team\n\n<!-- agentsmith:include team/rules.md -->\n");
    const result = await f.asmith("project", "init", "--template", "team");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(join(f.config, "partials", "team", "rules.md"), "utf8")).toBe("# Rules\n\nProject rules.\n");
    expect(existsSync(join(f.config, "partials", "team", "more.md"))).toBeFalse();
  });

  test("points an existing config's root scope at the copy, or keeps a template it already names", async () => {
    const f = await sourceTemplateFixture();
    expect((await f.asmith("project", "init")).exitCode).toBe(0);
    const added = await f.asmith("project", "init", "--template", "source:team");
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain('Set template = "project:team" for scope "."');
    const config = await readFile(join(f.config, "config.toml"), "utf8");
    expect(config).toContain('path = "."\ntemplate = "project:team"\npacks = []\n');
    expect(config).not.toContain("# template =");

    const other = await f.asmith("project", "init", "--template", "other");
    expect(other.exitCode, other.stderr).toBe(0);
    expect(other.stderr).toBe("");
    expect(other.stdout).toContain(
      '.config/agentsmith/config.toml was left unchanged, since scope "." already has a template. To use the copy, set template = "project:other" in the [[scopes]] entry that needs it.',
    );
    expect(await readFile(join(f.config, "config.toml"), "utf8")).toBe(config);
    expect(existsSync(join(f.config, "templates", "other", "default.md"))).toBeTrue();
  });

  test("hints at --template when a Source Repository has templates, and rejects what it cannot copy", async () => {
    const f = await sourceTemplateFixture();
    const hinted = await f.asmith("project", "init");
    expect(hinted.exitCode, hinted.stderr).toBe(0);
    expect(hinted.stdout).toContain("asmith project init --template <name>   (available: other, team)");

    for (const [args, message] of [
      [["--template", "project:team"], "already names a project template"],
      [["--template", "missing"], 'missing template source "source:missing"'],
    ] as const) {
      const result = await f.asmith("project", "init", ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(message);
    }
    await rm(f.machine);
    const noMachine = await f.asmith("project", "init", "--template", "team");
    expect(noMachine.exitCode).toBe(2);
    expect(noMachine.stderr).toContain("--template copies from your Source Repository, but there is no machine config");
    const quiet = await f.asmith("project", "init");
    expect(quiet.stdout).not.toContain("--template");
  });
});
