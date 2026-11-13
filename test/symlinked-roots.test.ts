import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Users reach home, project, and source directories through symlinked ancestors (macOS /var -> /private/var,
// Fedora Atomic /home -> /var/home). Those roots must work, while symlinked managed destinations stay rejected.
const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function run(command: string[], cwd: string, env: Record<string, string | undefined> = Bun.env) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

async function commitAll(dir: string): Promise<void> {
  expect((await run(["git", "init", "-q"], dir)).exitCode).toBe(0);
  await run(["git", "config", "user.email", "fixture@example.test"], dir);
  await run(["git", "config", "user.name", "Fixture"], dir);
  await run(["git", "add", "."], dir);
  expect((await run(["git", "commit", "-qm", "fixture"], dir)).exitCode).toBe(0);
}

/** A real root plus a symlink to it; every path the CLI sees goes through the symlink. */
async function linkedFixture() {
  const real = await mkdtemp(join(tmpdir(), "agentsmith-symlinked-"));
  const link = `${real}-link`;
  await symlink(real, link);
  const source = join(real, "source");
  await put(join(source, "agentsmith.toml"), "");
  await put(join(source, "profiles", "test.toml"), 'harnesses = ["generic", "claude"]\ntemplate = "base"\npacks = ["base"]\n');
  await put(join(source, "templates", "base", "default.md"), "# Guide\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(source, "packs", "base", "instructions", "notes", "10-note.md"), "Through a symlink.\n");
  await commitAll(source);
  const project = join(real, "project");
  await put(join(project, ".config", "agentsmith", "config.toml"), 'harnesses = ["codex"]\n\n[[scopes]]\npath = "."\ntemplate = "base"\npacks = ["base"]\n');
  await commitAll(project);
  const home = join(link, "home");
  await mkdir(join(real, "home"), { recursive: true });
  const machine = join(home, ".agents", "agentsmith", "config.toml");
  await put(machine, `source = ${JSON.stringify(join(link, "source"))}\nprofile = "test"\n`);
  const env = { ...Bun.env, HOME: home, CODEX_HOME: join(home, ".codex") };
  return { real, link, home, machine, env };
}

describe("symlinked roots", () => {
  test("project generation works when the project is reached through a symlinked ancestor", async () => {
    const setup = await linkedFixture();
    const project = join(setup.link, "project");
    const result = await run(["bun", cli, "project", "generate", "--project", project], project, setup.env);
    expect(result.exitCode, result.stderr).toBe(0);
    // Source Repository inputs are personal, so they land in Codex's personal override file.
    expect(await readFile(join(setup.real, "project", "AGENTS.override.md"), "utf8")).toContain("Through a symlink.");
  });

  test("global sync works when home and source are reached through a symlinked ancestor", async () => {
    const setup = await linkedFixture();
    const result = await run(["bun", cli, "global", "generate", "--config", setup.machine], setup.home, setup.env);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(join(setup.real, "home", ".claude", "CLAUDE.md"), "utf8")).toContain("Through a symlink.");
  });

  test("a symlinked managed directory is still rejected", async () => {
    const setup = await linkedFixture();
    const elsewhere = join(setup.real, "dotfiles-claude");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(setup.real, "home", ".claude"));
    const result = await run(["bun", cli, "global", "generate", "--config", setup.machine], setup.home, setup.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Symlink destination or ancestor is not allowed");
    expect(result.stderr).toContain(".claude");
  });
});
