import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

/**
 * A real home whose global Git config holds the only identity, and a sandbox whose machine config sets `home`.
 * Nothing in the Source Repository configures an identity, so a commit only succeeds through the real `$HOME`.
 */
async function sandboxFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-sandbox-"));
  const realHome = join(root, "real-home");
  const sandbox = join(root, "sandbox");
  const home = join(sandbox, "home");
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const source = join(sandbox, "source");
  await mkdir(home, { recursive: true });
  await put(join(realHome, ".gitconfig"), "[user]\n\tname = Real Identity\n\temail = real@example.test\n[init]\n\tdefaultBranch = main\n");
  const env = { ...Bun.env, HOME: realHome, CODEX_HOME: join(realHome, ".codex-from-env"), XDG_CONFIG_HOME: undefined, GIT_CONFIG_GLOBAL: undefined };
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
  await put(join(seed, "profiles", "test.toml"), ['harnesses = ["generic", "codex", "claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
  await put(join(seed, "templates", "base", "default.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(seed, "packs", "base", "pack.toml"), 'skills = ["review"]\n');
  await put(join(seed, "packs", "base", "instructions", "notes", "10-shared.md"), "Shared note.\n");
  await put(join(seed, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review.\n---\n\nReview.\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "source");
  await git(seed, "push", "-u", remote, "HEAD:main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", remote, source);
  const config = join(sandbox, "config.toml");
  await put(config, `source = "source"\nprofile = "test"\nhome = "home"\n`);
  const asmith = (args: string[]) => run(["bun", cli, ...args], root, env);
  return { root, realHome, sandbox, home, source, config, git, asmith };
}

/** Entries in the real home other than the Git identity and Bun's own cache (`Library/Caches/bun` on macOS). */
async function agentsmithEntries(realHome: string): Promise<string[]> {
  return (await readdir(realHome)).filter((name) => name !== ".gitconfig" && name !== "Library" && name !== ".cache" && name !== ".bun").sort();
}

describe("sandbox home", () => {
  test("generates, syncs, reports status, and adds inside the sandbox while Git uses the real identity", async () => {
    const f = await sandboxFixture();
    const generated = await f.asmith(["global", "generate", "--config", f.config]);
    expect(generated.exitCode, generated.stderr).toBe(0);
    expect(await readFile(join(f.home, ".claude", "CLAUDE.md"), "utf8")).toContain("Shared note.");
    // CODEX_HOME is ignored while home is set.
    expect(await readFile(join(f.home, ".codex", "AGENTS.md"), "utf8")).toContain("Shared note.");
    expect(existsSync(join(f.home, ".agents", "skills", "review", "SKILL.md"))).toBeTrue();
    expect(existsSync(join(f.home, ".agents", "agentsmith", "state.toml"))).toBeTrue();
    expect(existsSync(join(f.home, ".agents", "agentsmith", "blobs"))).toBeTrue();
    expect(existsSync(join(f.home, ".agents", "agentsmith", "status.json"))).toBeTrue();

    const synced = await f.asmith(["global", "sync", "--config", f.config]);
    expect(synced.exitCode, synced.stderr).toBe(0);
    const status = await f.asmith(["global", "status", "--config", f.config]);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain("Last run: global sync succeeded");
    expect(status.stdout).toContain(`Home: ${f.home}`);
    expect(status.stdout).toContain(`Status file: ${join(f.home, ".agents", "agentsmith", "status.json")}`);
    const json = JSON.parse((await f.asmith(["global", "status", "--config", f.config, "--json"])).stdout);
    expect(json).toMatchObject({ home: f.home, path: join(f.home, ".agents", "agentsmith", "status.json"), healthy: true });

    const added = await f.asmith(["global", "add", "notes", "Sandboxed note.", "--config", f.config, "--push"]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(await f.git(f.source, "log", "-1", "--format=%an <%ae>")).toBe("Real Identity <real@example.test>\n");
    expect(await readFile(join(f.home, ".claude", "CLAUDE.md"), "utf8")).toContain("Sandboxed note.");

    // The edited artifact is backed up inside the sandbox.
    await writeFile(join(f.home, ".claude", "CLAUDE.md"), "edited\n");
    const backup = await f.asmith(["global", "generate", "--config", f.config, "--on-modified=backup"]);
    expect(backup.exitCode, backup.stderr).toBe(0);
    expect((await readdir(join(f.home, ".claude"))).some((name) => name.startsWith("CLAUDE.md.agentsmith-"))).toBeTrue();

    // A modified artifact error names the sandbox path.
    await writeFile(join(f.home, ".claude", "CLAUDE.md"), "edited again\n");
    const refused = await f.asmith(["global", "generate", "--config", f.config]);
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(join(f.home, ".claude", "CLAUDE.md"));

    // Nothing agentsmith owns landed in the real home.
    expect(await agentsmithEntries(f.realHome)).toEqual([]);
  });

  test("records a failed run's status in the sandbox even when the config is otherwise invalid", async () => {
    const f = await sandboxFixture();
    await put(f.config, `source = "missing"\nprofile = "test"\nhome = "home"\n`);
    const failed = await f.asmith(["global", "sync", "--config", f.config]);
    expect(failed.exitCode).toBe(2);
    const status = JSON.parse(await readFile(join(f.home, ".agents", "agentsmith", "status.json"), "utf8"));
    expect(status).toMatchObject({ outcome: "failure", exitCode: 2 });
    expect(await agentsmithEntries(f.realHome)).toEqual([]);
  });

  test("global init keeps a configured home and clones into the sandbox by default", async () => {
    const f = await sandboxFixture();
    const config = join(f.sandbox, "fresh.toml");
    await put(config, `home = "home"\nprofile = "test"\nsource = "elsewhere"\n`);
    const remote = join(f.root, "remote.git");
    const init = await f.asmith(["global", "init", remote, "--profile", "test", "--config", config, "--yes"]);
    expect(init.exitCode, init.stderr).toBe(0);
    const written = await readFile(config, "utf8");
    expect(written).toContain('home = "home"');
    expect(written).toContain(JSON.stringify(join(f.home, ".agents", "agentsmith", "source")));
    expect(existsSync(join(f.home, ".agents", "agentsmith", "source", "profiles", "test.toml"))).toBeTrue();
    expect(existsSync(join(f.home, ".claude", "CLAUDE.md"))).toBeTrue();
    expect(await agentsmithEntries(f.realHome)).toEqual([]);
  });
});
