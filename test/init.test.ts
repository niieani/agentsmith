import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeRemote } from "../src/init.ts";

const cli = resolve(import.meta.dir, "..", "src", "cli.ts");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function run(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

async function createRemote(root: string, name: string, profiles: Record<string, string>): Promise<string> {
  const remote = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await mkdir(seed, { recursive: true });
  expect((await run(["git", "init", "--bare", remote], root)).exitCode).toBe(0);
  expect((await run(["git", "init"], seed)).exitCode).toBe(0);
  await run(["git", "config", "user.email", "fixture@example.test"], seed);
  await run(["git", "config", "user.name", "Fixture"], seed);
  await put(join(seed, "agentsmith.toml"), "");
  for (const [profile, content] of Object.entries(profiles)) await put(join(seed, "profiles", `${profile}.toml`), content);
  await put(join(seed, "templates", "base", "default.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(seed, "packs", "base", "instructions", "notes", "10-shared.md"), "Shared note.\n");
  await put(join(seed, "packs", "extra", "instructions", "notes", "20-extra.md"), "Extra note.\n");
  await run(["git", "add", "."], seed);
  expect((await run(["git", "commit", "-m", "source"], seed)).exitCode).toBe(0);
  await run(["git", "remote", "add", "origin", remote], seed);
  expect((await run(["git", "push", "-u", "origin", "HEAD:main"], seed)).exitCode).toBe(0);
  await run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], remote);
  return remote;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-init-"));
  temporary.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const remote = await createRemote(root, "remote", {
    test: ['harnesses = ["claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
    work: ['extends = "test"', 'packs = ["extra"]', ""].join("\n"),
  });
  const env = { ...Bun.env, HOME: home, CODEX_HOME: join(home, ".codex") };
  const asmith = (...args: string[]) => run(["bun", cli, ...args], root, env);
  const agentsmith = join(home, ".agents", "agentsmith");
  return {
    root,
    home,
    remote,
    asmith,
    source: join(agentsmith, "source"),
    config: join(agentsmith, "config.toml"),
    statusFile: join(agentsmith, "status.json"),
    instruction: join(home, ".claude", "CLAUDE.md"),
  };
}

describe("global init", () => {
  test("clones, configures, syncs, and reuses an existing clone", async () => {
    const f = await fixture();
    const first = await f.asmith("global", "init", f.remote, "--profile", "work");
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain(`Cloning ${f.remote} into ${f.source}`);
    expect(first.stdout).toContain("Lint passed with 0 warning(s).");
    expect(first.stdout).toMatch(/create\s+.*CLAUDE\.md/);
    expect(await readFile(f.config, "utf8")).toBe(`source = ${JSON.stringify(f.source)}\nprofile = "work"\n`);
    const generated = await readFile(f.instruction, "utf8");
    expect(generated).toContain("Shared note.");
    expect(generated).toContain("Extra note.");
    const status = JSON.parse(await readFile(f.statusFile, "utf8")) as Record<string, unknown>;
    expect(status).toMatchObject({ command: "sync", outcome: "success", profile: "work" });

    const again = await f.asmith("global", "init", `${f.remote}/`, "--profile", "work");
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stdout).toContain(`Reusing existing clone at ${f.source}`);
    expect(again.stdout).toContain("already selects profile work");
    expect(again.stdout).toMatch(/unchanged\s+.*CLAUDE\.md/);
  });

  test("lists available profiles when the profile does not resolve", async () => {
    const f = await fixture();
    const missing = await f.asmith("global", "init", f.remote, "--profile", "laptop");
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('Profile "laptop" not found');
    expect(missing.stderr).toContain("Available profiles: test, work");
    expect(await Bun.file(f.config).exists()).toBe(false);
  });

  test("refuses to replace a different machine config without --yes", async () => {
    const f = await fixture();
    expect((await f.asmith("global", "init", f.remote, "--profile", "test")).exitCode).toBe(0);
    const refused = await f.asmith("global", "init", f.remote, "--profile", "work");
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("already exists with source");
    expect(refused.stderr).toContain(`asmith global init ${f.remote} --profile work --yes`);
    expect(await readFile(f.config, "utf8")).toContain('profile = "test"');

    const replaced = await f.asmith("global", "init", f.remote, "--profile", "work", "--yes");
    expect(replaced.exitCode, replaced.stderr).toBe(0);
    expect(await readFile(f.config, "utf8")).toContain('profile = "work"');
    expect(await readFile(f.instruction, "utf8")).toContain("Extra note.");
  });

  test("refuses a source path that holds a different repository or no repository", async () => {
    const f = await fixture();
    const other = await createRemote(f.root, "other", { test: 'harnesses = ["claude"]\ntemplate = "base"\n' });
    expect((await run(["git", "clone", other, f.source], f.root)).exitCode).toBe(0);
    const different = await f.asmith("global", "init", f.remote, "--profile", "test");
    expect(different.exitCode).toBe(2);
    expect(different.stderr).toContain("is a clone of a different repository");

    const plain = join(f.root, "plain");
    await put(join(plain, "notes.txt"), "not a repository\n");
    const notGit = await f.asmith("global", "init", f.remote, "--profile", "test", "--source", plain);
    expect(notGit.exitCode).toBe(2);
    expect(notGit.stderr).toContain("not a Git worktree");
  });

  test("stops over an unrecorded CLAUDE.md without --yes and backs it up with --yes", async () => {
    const f = await fixture();
    await put(f.instruction, "# My own notes\n");
    const refused = await f.asmith("global", "init", f.remote, "--profile", "test");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(`existing file not written by agentsmith: ${f.instruction}`);
    expect(refused.stderr).toContain("-# My own notes");
    expect(refused.stderr).toContain(`asmith global init ${f.remote} --profile test --yes`);
    expect(await readFile(f.instruction, "utf8")).toBe("# My own notes\n");
    expect(await Bun.file(f.statusFile).exists()).toBe(false);

    const adopted = await f.asmith("global", "init", f.remote, "--profile", "test", "--yes");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(await readFile(f.instruction, "utf8")).toContain("Shared note.");
    const backups = (await readdir(join(f.home, ".claude"))).filter((name) => name.startsWith("CLAUDE.md.agentsmith-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(f.home, ".claude", backups[0]!), "utf8")).toBe("# My own notes\n");
    const status = JSON.parse(await readFile(f.statusFile, "utf8")) as { outcome: string; backups: unknown[]; warnings: string[] };
    expect(status.outcome).toBe("success");
    expect(status.backups).toHaveLength(1);
    expect(status.warnings.join("\n")).toContain("artifact-backup");
  });

  test("rejects --interval without --schedule", async () => {
    const f = await fixture();
    const result = await f.asmith("global", "init", f.remote, "--profile", "test", "--interval", "2h");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--interval requires --schedule");
  });
});

test("normalizeRemote compares equivalent remote spellings", () => {
  expect(normalizeRemote("git@github.com:me/context.git")).toBe(normalizeRemote("git@github.com:me/context"));
  expect(normalizeRemote("https://github.com/me/context.git/")).toBe("https://github.com/me/context");
  expect(normalizeRemote("/srv/context.git", "/")).toBe(normalizeRemote("file:///srv/context.git"));
  expect(normalizeRemote("../context.git", "/srv/work")).toBe("/srv/context");
});
