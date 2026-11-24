import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { owningScope } from "../src/clean.ts";

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

/** Every file and directory below `root`, relative, with file content; `skip` names relative paths to leave out. */
async function tree(root: string, skip: readonly string[] = []): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (skip.includes(rel)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        result[`${rel}/`] = "";
        await visit(path, `${rel}/`);
      } else result[rel] = await readFile(path, "utf8");
    }
  };
  await visit(root, "");
  return result;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill.\n---\n\nBody.\n`;

test("owningScope picks the deepest declared scope", () => {
  const scopes = [".", "app", "app/web"];
  expect(owningScope("AGENTS.md", scopes)).toBe(".");
  expect(owningScope("app/AGENTS.md", scopes)).toBe("app");
  expect(owningScope("app/web/.claude/skills/a/SKILL.md", scopes)).toBe("app/web");
  expect(owningScope("apple/AGENTS.md", scopes)).toBe(".");
});

async function globalFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-clean-"));
  const realHome = join(root, "real-home");
  const home = join(root, "home");
  const source = join(root, "source");
  await mkdir(home, { recursive: true });
  await mkdir(realHome, { recursive: true });
  const env = { ...Bun.env, HOME: realHome, CODEX_HOME: undefined };
  await put(join(source, "agentsmith.toml"), "");
  await put(join(source, "profiles", "test.toml"), ['harnesses = ["generic", "codex", "claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
  await put(join(source, "templates", "base", "default.md"), "# Global\n");
  await put(join(source, "packs", "base", "pack.toml"), 'skills = ["review"]\n');
  await put(join(source, "skills", "review", "SKILL.md"), skill("review"));
  await put(join(source, "skills", "review", "notes", "extra.md"), "Extra.\n");
  const config = join(root, "config.toml");
  await put(config, `source = "source"\nprofile = "test"\nhome = "home"\n`);
  const asmith = (...args: string[]) => run(["bun", cli, ...args, "--config", config], root, env);
  return { root, home, source, config, asmith };
}

describe("global clean", () => {
  test("dry-runs, deletes with --yes, and a following generate recreates the same tree", async () => {
    const f = await globalFixture();
    // A pre-existing file keeps its directory.
    await put(join(f.home, ".claude", "settings.json"), "{}\n");
    expect((await f.asmith("global", "generate")).exitCode).toBe(0);
    const generated = await tree(f.home, [".agents/agentsmith/status.json"]);
    expect(generated[".claude/CLAUDE.md"]).toBe("# Global\n");
    expect(generated[".agents/skills/review/notes/extra.md"]).toBe("Extra.\n");

    const dry = await f.asmith("global", "clean");
    expect(dry.exitCode, dry.stderr).toBe(0);
    for (const path of [
      join(f.home, ".claude", "CLAUDE.md"),
      join(f.home, ".codex", "AGENTS.md"),
      join(f.home, ".agents", "skills", "review", "SKILL.md"),
      join(f.home, ".agents", "agentsmith", "state.toml"),
      join(f.home, ".agents", "agentsmith", "status.json"),
      join(f.home, ".agents", "agentsmith", "blobs"),
    ])
      expect(dry.stdout).toContain(path);
    expect(dry.stdout).toContain("Dry run; rerun with --yes");
    expect(await tree(f.home, [".agents/agentsmith/status.json"])).toEqual(generated);

    const cleaned = await f.asmith("global", "clean", "-y");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect(await tree(f.home)).toEqual({ ".claude/": "", ".claude/settings.json": "{}\n" });
    // Everything happened inside the sandbox home.
    expect(
      (await readdir(join(f.root, "real-home"))).filter((name) => name.startsWith(".agents") || name.startsWith(".claude") || name.startsWith(".codex")),
    ).toEqual([]);
    // The machine config and Source Repository stay.
    expect(existsSync(f.config)).toBeTrue();
    expect(existsSync(join(f.source, "profiles", "test.toml"))).toBeTrue();

    expect((await f.asmith("global", "generate")).exitCode).toBe(0);
    expect(await tree(f.home, [".agents/agentsmith/status.json"])).toEqual(generated);
  });

  test("refuses a modified artifact unless --on-modified=backup or --force", async () => {
    const f = await globalFixture();
    expect((await f.asmith("global", "generate")).exitCode).toBe(0);
    const claude = join(f.home, ".claude", "CLAUDE.md");
    await writeFile(claude, "edited\n");

    const refused = await f.asmith("global", "clean", "--yes");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(claude);
    expect(existsSync(join(f.home, ".codex", "AGENTS.md"))).toBeTrue();
    expect(existsSync(join(f.home, ".agents", "agentsmith", "state.toml"))).toBeTrue();
    expect((await f.asmith("global", "clean")).exitCode).toBe(5);

    const skillFile = join(f.home, ".agents", "skills", "review", "SKILL.md");
    await writeFile(skillFile, "edited skill\n");
    const backedUp = await f.asmith("global", "clean", "--yes", "--on-modified=backup");
    expect(backedUp.exitCode, backedUp.stderr).toBe(0);
    expect(existsSync(claude)).toBeFalse();
    const backups = (await readdir(join(f.home, ".claude"))).filter((name) => name.startsWith("CLAUDE.md.agentsmith-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(f.home, ".claude", backups[0]!), "utf8")).toBe("edited\n");
    // A modified skill file backs up its whole skill directory; backups survive clean.
    const [stamp] = await readdir(join(f.home, ".agents", "agentsmith", "backups"));
    const skillBackup = join(f.home, ".agents", "agentsmith", "backups", stamp!, join(f.home, ".agents", "skills", "review").slice(1));
    expect(await readFile(join(skillBackup, "SKILL.md"), "utf8")).toBe("edited skill\n");
    expect(existsSync(join(f.home, ".agents", "skills"))).toBeFalse();
    expect(existsSync(join(f.home, ".agents", "agentsmith", "state.toml"))).toBeFalse();

    expect((await f.asmith("global", "generate")).exitCode).toBe(0);
    await writeFile(claude, "edited again\n");
    const forced = await f.asmith("global", "clean", "--yes", "--force");
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(existsSync(claude)).toBeFalse();
  });

  test("refuses an invalid sandbox home instead of cleaning the real one", async () => {
    const f = await globalFixture();
    await put(f.config, `source = "source"\nprofile = "test"\nhome = "hmoe"\n`);
    const result = await f.asmith("global", "clean", "--yes");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("home is not an existing directory");
  });

  test("with nothing recorded reports nothing to clean", async () => {
    const f = await globalFixture();
    const result = await f.asmith("global", "clean", "--yes");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Nothing to clean");
  });
});

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-clean-project-"));
  const project = join(root, "project");
  const config = join(project, ".config", "agentsmith");
  await put(
    join(config, "config.toml"),
    [
      'harnesses = ["generic", "claude"]',
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
      "",
    ].join("\n"),
  );
  await put(join(config, "templates", "base", "default.md"), "# Project\n");
  await put(join(config, "packs", "local", "pack.toml"), 'skills = ["tool"]\n');
  await put(join(config, "skills", "tool", "SKILL.md"), skill("tool"));
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
  return { root, project, git, asmith };
}

describe("project clean", () => {
  test("removes generated files as Git deletions, refuses modified ones, and regenerates the same tree", async () => {
    const f = await projectFixture();
    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    await f.git("add", ".");
    await f.git("commit", "-m", "generated");
    const generated = await tree(f.project, [".git"]);
    expect(generated["app/CLAUDE.md"]).toBe("@AGENTS.md\n");

    const dry = await f.asmith("project", "clean");
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(join(f.project, "AGENTS.md"));
    expect(dry.stdout).toContain(join(f.project, ".git", "agentsmith", "state.toml"));
    expect(await tree(f.project, [".git"])).toEqual(generated);

    await writeFile(join(f.project, "AGENTS.md"), "edited\n");
    const refused = await f.asmith("project", "clean", "--yes");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(join(f.project, "AGENTS.md"));
    await f.git("checkout", "--", "AGENTS.md");

    // One scope at a time: state keeps the other scope's paths.
    const app = await f.asmith("project", "clean", "--scope", "app", "--yes");
    expect(app.exitCode, app.stderr).toBe(0);
    expect(existsSync(join(f.project, "app", "AGENTS.md"))).toBeFalse();
    expect(existsSync(join(f.project, "AGENTS.md"))).toBeTrue();
    expect(await readFile(join(f.project, ".git", "agentsmith", "state.toml"), "utf8")).not.toContain("app/");
    expect(await readFile(join(f.project, ".git", "agentsmith", "state.toml"), "utf8")).toContain("AGENTS.md");

    const cleaned = await f.asmith("project", "clean", "-y");
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect(cleaned.stdout).toContain("review and commit the deletions");
    expect(existsSync(join(f.project, ".git", "agentsmith"))).toBeFalse();
    expect(existsSync(join(f.project, ".agents"))).toBeFalse();
    expect(existsSync(join(f.project, ".claude"))).toBeFalse();
    expect(existsSync(join(f.project, "app", "README.md"))).toBeTrue();
    expect(
      (await f.git("status", "--porcelain"))
        .split("\n")
        .filter(Boolean)
        .every((line) => line.startsWith(" D ")),
    ).toBeTrue();

    expect((await f.asmith("project", "generate")).exitCode).toBe(0);
    expect(await tree(f.project, [".git"])).toEqual(generated);
    expect(await f.git("status", "--porcelain")).toBe("");

    await writeFile(join(f.project, "CLAUDE.md"), "edited\n");
    const backedUp = await f.asmith("project", "clean", "--yes", "--on-modified=backup");
    expect(backedUp.exitCode, backedUp.stderr).toBe(0);
    const [stamp] = await readdir(join(f.project, ".git", "agentsmith", "backups"));
    expect(await readFile(join(f.project, ".git", "agentsmith", "backups", stamp!, join(f.project, "CLAUDE.md").slice(1)), "utf8")).toBe("edited\n");
    expect(existsSync(join(f.project, ".git", "agentsmith", "state.toml"))).toBeFalse();
  });
});

test("project clean --scope resolves scopes of a project below the worktree root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-clean-nested-"));
  const worktree = join(root, "repo");
  const project = join(worktree, "app");
  const config = join(project, ".config", "agentsmith");
  await put(
    join(config, "config.toml"),
    ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'template = "base"', "", "[[scopes]]", 'path = "api"', 'template = "base"', ""].join("\n"),
  );
  await put(join(config, "templates", "base", "default.md"), "# Project\n");
  await put(join(project, "api", "README.md"), "api\n");
  const env = { ...Bun.env, HOME: root, CODEX_HOME: undefined };
  const git = async (...args: string[]) => expect((await run(["git", ...args], worktree, env)).exitCode).toBe(0);
  await git("init", "-q");
  await git("config", "user.email", "fixture@example.test");
  await git("config", "user.name", "Fixture");
  const asmith = (...args: string[]) => run(["bun", cli, ...args], project, env);
  expect((await asmith("project", "generate")).exitCode).toBe(0);
  await git("add", ".");
  await git("commit", "-qm", "generated");

  const api = await asmith("project", "clean", "--scope", "api", "--yes");
  expect(api.exitCode, api.stderr).toBe(0);
  expect(existsSync(join(project, "api", "AGENTS.md"))).toBeFalse();
  expect(existsSync(join(project, "AGENTS.md"))).toBeTrue();
});
