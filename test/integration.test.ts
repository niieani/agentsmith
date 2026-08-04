import { describe, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

describe("CLI project workflow", () => {
  test("generates, protects untracked output, and regenerates after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-e2e-"));
    const source = join(root, "source");
    const project = join(root, "project");
    const skill = "agentsmith-e2e-review";
    await mkdir(project, { recursive: true });
    await put(join(source, "agentsmith.toml"), "");
    await put(join(source, "templates", "base", "default.md"), "# Guide\n\n<!-- agentsmith:slot notes -->\n");
    await put(join(source, "packs", "base", "pack.toml"), `skills = ["${skill}"]\n`);
    await put(join(source, "packs", "base", "instructions", "notes", "10-note.md"), "Use the fixture.\n");
    await put(join(source, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Fixture workflow.\n---\n\nDo the fixture work.\n`);
    const machine = join(root, ".agents", "agentsmith", "config.toml");
    await put(machine, `source = ${JSON.stringify(source)}\nprofile = "unused"\n`);
    await put(
      join(project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex", "claude-code"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
    );
    expect((await run(["git", "init"], project)).exitCode).toBe(0);
    await run(["git", "config", "user.email", "fixture@example.test"], project);
    await run(["git", "config", "user.name", "Fixture"], project);
    await run(["git", "add", "."], project);
    expect((await run(["git", "commit", "-m", "fixture"], project)).exitCode).toBe(0);

    const args = ["bun", cli, "project", "generate", "--project", project];
    const env = { ...Bun.env, HOME: root };
    const firstChild = Bun.spawn(args, { cwd: project, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [firstOut, firstErr, firstCode] = await Promise.all([
      new Response(firstChild.stdout).text(),
      new Response(firstChild.stderr).text(),
      firstChild.exited,
    ]);
    expect(firstCode, firstErr).toBe(0);
    expect(firstOut).toContain("Generated 4 file(s)");
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).toContain("Use the fixture.");
    expect(await readFile(join(project, ".claude", "skills", skill, "SKILL.md"), "utf8")).toContain("Fixture workflow");

    const second = Bun.spawn(args, { cwd: project, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const secondCode = await second.exited;
    const secondError = await new Response(second.stderr).text();
    expect(secondCode).toBe(1);
    expect(secondError).toContain("untracked project destination");

    await run(["git", "add", "."], project);
    expect((await run(["git", "commit", "-m", "generated"], project)).exitCode).toBe(0);
    const third = Bun.spawn(args, { cwd: project, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [thirdError, thirdCode] = await Promise.all([new Response(third.stderr).text(), third.exited]);
    expect(thirdCode, thirdError).toBe(0);

    await put(
      join(project, ".config", "agentsmith", "config.toml"),
      [
        'harnesses = ["codex", "claude-code"]',
        "",
        "[[scopes]]",
        'path = "."',
        'template = "base"',
        'packs = ["base"]',
        `skills_disable = ["${skill}"]`,
        "",
      ].join("\n"),
    );
    const disabled = Bun.spawn(args, { cwd: project, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [disabledError, disabledCode] = await Promise.all([new Response(disabled.stderr).text(), disabled.exited]);
    expect(disabledCode, disabledError).toBe(0);
    expect(
      await access(join(project, ".agents", "skills", skill)).then(
        () => true,
        () => false,
      ),
    ).toBeFalse();
  });
});

describe("CLI global workflow", () => {
  test("fast-forward sync renders ignored local source and protects global edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-global-e2e-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const source = join(root, "source");
    await mkdir(seed, { recursive: true });
    expect((await run(["git", "init", "--bare", remote], root)).exitCode).toBe(0);
    expect((await run(["git", "init"], seed)).exitCode).toBe(0);
    await run(["git", "config", "user.email", "fixture@example.test"], seed);
    await run(["git", "config", "user.name", "Fixture"], seed);
    await put(join(seed, ".gitignore"), "*.local.md\n");
    await put(join(seed, "agentsmith.toml"), "");
    await put(join(seed, "profiles", "test.toml"), ['harnesses = ["codex"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
    await put(join(seed, "templates", "base", "codex.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n");
    await put(join(seed, "packs", "base", "instructions", "notes", "10-shared.md"), "Shared note.\n");
    await run(["git", "add", "."], seed);
    expect((await run(["git", "commit", "-m", "source"], seed)).exitCode).toBe(0);
    await run(["git", "remote", "add", "origin", remote], seed);
    expect((await run(["git", "push", "-u", "origin", "HEAD:main"], seed)).exitCode).toBe(0);
    await run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], remote);
    expect((await run(["git", "clone", remote, source], root)).exitCode).toBe(0);
    await put(join(source, "packs", "base", "instructions", "notes", "20-studio.local.md"), "Studio-only note.\n");
    await put(join(root, ".agents", "agentsmith", "config.toml"), `source = ${JSON.stringify(source)}\nprofile = "test"\n`);
    const env = { ...Bun.env, HOME: root, CODEX_HOME: join(root, ".codex") };
    const args = ["bun", cli, "global", "sync"];
    const first = Bun.spawn(args, { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [firstError, firstCode] = await Promise.all([new Response(first.stderr).text(), first.exited]);
    expect(firstCode, firstError).toBe(0);
    const destination = join(root, ".codex", "AGENTS.md");
    const generated = await readFile(destination, "utf8");
    expect(generated).toContain("Shared note.");
    expect(generated).toContain("Studio-only note.");

    await writeFile(destination, `${generated}\nmanual edit\n`);
    const protectedRun = Bun.spawn(["bun", cli, "global", "generate"], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [protectedError, protectedCode] = await Promise.all([new Response(protectedRun.stderr).text(), protectedRun.exited]);
    expect(protectedCode).toBe(1);
    expect(protectedError).toContain("modified global artifact");

    const forced = Bun.spawn(["bun", cli, "global", "generate", "--force"], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [forcedError, forcedCode] = await Promise.all([new Response(forced.stderr).text(), forced.exited]);
    expect(forcedCode, forcedError).toBe(0);
    expect(await readFile(destination, "utf8")).not.toContain("manual edit");
  });
});

describe("read-only project workflows", () => {
  test("diff works without a Git worktree and reports reduced stale-state coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-no-git-"));
    await put(
      join(root, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
    );
    await put(join(root, ".config", "agentsmith", "templates", "base", "codex.md"), "# Project\n\n<!-- agentsmith:slot note -->\n");
    await put(join(root, ".config", "agentsmith", "packs", "base", "instructions", "note", "10-note.md"), "No Git required.\n");
    const env = { ...Bun.env, HOME: root, CODEX_HOME: join(root, ".codex") };
    const child = Bun.spawn(["bun", cli, "project", "diff", "--project", root], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("No Git required.");
    expect(stderr).toContain("project-diff-without-git-state");

    const human = Bun.spawn(["bun", cli, "project", "explain", "--project", root], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [humanOut, humanErr, humanCode] = await Promise.all([new Response(human.stdout).text(), new Response(human.stderr).text(), human.exited]);
    expect(humanCode, humanErr).toBe(0);
    expect(humanOut).toContain(`pack project:base: ${join(root, ".config", "agentsmith", "packs", "base")} (selected as base)`);

    const json = Bun.spawn(["bun", cli, "project", "explain", "--project", root, "--json"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [jsonOut, jsonErr, jsonCode] = await Promise.all([new Response(json.stdout).text(), new Response(json.stderr).text(), json.exited]);
    expect(jsonCode, jsonErr).toBe(0);
    const explanation = JSON.parse(jsonOut) as { artifacts: Array<{ packSources?: unknown[] }> };
    expect(explanation.artifacts[0]?.packSources).toEqual([
      { selection: "base", sourceId: "project:base", directory: join(root, ".config", "agentsmith", "packs", "base") },
    ]);
  });
});
