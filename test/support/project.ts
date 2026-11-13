import { expect } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const cli = resolve(import.meta.dir, "..", "..", "src", "cli.ts");

export async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

export async function run(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

/** Every file below `root`, relative, with content; `skip` names relative paths to leave out. */
export async function tree(root: string, skip: readonly string[] = [".git"]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (skip.includes(rel)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, `${rel}/`);
      else result[rel] = await readFile(path, "utf8");
    }
  };
  await visit(root, "");
  return result;
}

export const skillMd = (name: string, body = "Body.") => `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${body}\n`;

export interface ProjectFixture {
  root: string;
  project: string;
  /** `.config/agentsmith` inside the project. */
  config: string;
  /** Source Repository root (exists only when the fixture has a machine config). */
  source: string;
  machine: string;
  env: Record<string, string | undefined>;
  git: (...args: string[]) => Promise<string>;
  asmith: (...args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** A Git repository at `<root>/project` with HOME at `<root>`; the machine config lives at the default path. */
export async function projectFixture(prefix = "agentsmith-project-"): Promise<ProjectFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, "project");
  const config = join(project, ".config", "agentsmith");
  const source = join(root, "source");
  const machine = join(root, ".agents", "agentsmith", "config.toml");
  await mkdir(project, { recursive: true });
  const env = { ...Bun.env, HOME: root, CODEX_HOME: undefined };
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args], project, env);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  await git("init", "-q");
  await git("config", "user.email", "fixture@example.test");
  await git("config", "user.name", "Fixture");
  const asmith = (...args: string[]) => run(["bun", cli, ...args], project, env);
  return { root, project, config, source, machine, env, git, asmith };
}

export async function commitAll(f: ProjectFixture, message = "commit"): Promise<void> {
  await f.git("add", "-A");
  await f.git("commit", "-qm", message, "--allow-empty");
}
