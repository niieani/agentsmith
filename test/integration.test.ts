import { describe, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
      ['harnesses = ["generic", "codex", "claude"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
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
    expect(await readFile(join(project, ".agents", "skills", skill, "SKILL.md"), "utf8")).toContain("Fixture workflow");
    expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(
      await access(join(project, ".codex")).then(
        () => true,
        () => false,
      ),
    ).toBeFalse();

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
        'harnesses = ["generic", "codex", "claude"]',
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
    expect(protectedCode).toBe(5);
    expect(protectedError).toContain("modified global artifact");

    const forced = Bun.spawn(["bun", cli, "global", "generate", "--force"], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [forcedError, forcedCode] = await Promise.all([new Response(forced.stderr).text(), forced.exited]);
    expect(forcedCode, forcedError).toBe(0);
    expect(await readFile(destination, "utf8")).not.toContain("manual edit");
  });
});

describe("CLI global explain", () => {
  test("shows the resolved profile chain and the profile contributing each pack", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentsmith-extends-"));
    const source = join(root, "source");
    await put(join(source, "agentsmith.toml"), "");
    await put(join(source, "profiles", "mac.toml"), ['harnesses = ["codex"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
    await put(join(source, "profiles", "laptop.toml"), ['extends = "mac"', 'packs = ["travel"]', ""].join("\n"));
    await put(join(source, "templates", "base", "codex.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n");
    await put(join(source, "packs", "base", "instructions", "notes", "10-base.md"), "Base note.\n");
    await put(join(source, "packs", "travel", "instructions", "notes", "20-travel.md"), "Travel note.\n");
    await put(join(root, ".agents", "agentsmith", "config.toml"), `source = ${JSON.stringify(source)}\nprofile = "laptop"\n`);
    const env = { ...Bun.env, HOME: root, CODEX_HOME: join(root, ".codex") };
    const spawn = async (args: string[]) => {
      const child = Bun.spawn(["bun", cli, "global", "explain", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0);
      return stdout;
    };
    const human = await spawn([]);
    expect(human).toContain("Profile: laptop (chain: mac -> laptop)\n  pack base: from profile mac\n  pack travel: from profile laptop\n");
    const explanation = JSON.parse(await spawn(["--json"])) as { profile: unknown };
    expect(explanation.profile).toEqual({
      name: "laptop",
      chain: ["mac", "laptop"],
      packs: [
        { pack: "base", profile: "mac" },
        { pack: "travel", profile: "laptop" },
      ],
    });
  });
});

describe("read-only project workflows", () => {
  for (const runtime of ["bun", "node"]) {
    test(`diff works under ${runtime} without a Git worktree and reports reduced stale-state coverage`, async () => {
      const root = await mkdtemp(join(tmpdir(), "agentsmith-no-git-"));
      await put(
        join(root, ".config", "agentsmith", "config.toml"),
        ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
      );
      await put(join(root, ".config", "agentsmith", "templates", "base", "codex.md"), "# Project\n\n<!-- agentsmith:slot note -->\n");
      await put(join(root, ".config", "agentsmith", "packs", "base", "instructions", "note", "10-note.md"), "No Git required.\n");
      const env = { ...Bun.env, HOME: root, CODEX_HOME: join(root, ".codex") };
      const child = Bun.spawn([runtime, cli, "project", "diff", "--project", root], {
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

      const human = Bun.spawn([runtime, cli, "project", "explain", "--project", root], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [humanOut, humanErr, humanCode] = await Promise.all([new Response(human.stdout).text(), new Response(human.stderr).text(), human.exited]);
      expect(humanCode, humanErr).toBe(0);
      expect(humanOut).toContain(`pack project:base: ${join(root, ".config", "agentsmith", "packs", "base")} (selected as base)`);

      const json = Bun.spawn([runtime, cli, "project", "explain", "--project", root, "--json"], {
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
  }
});

async function globalFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-reliability-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const source = join(root, "source");
  const skill = "fixture-skill";
  await mkdir(seed, { recursive: true });
  expect((await run(["git", "init", "--bare", remote], root)).exitCode).toBe(0);
  expect((await run(["git", "init"], seed)).exitCode).toBe(0);
  for (const repo of [seed]) {
    await run(["git", "config", "user.email", "fixture@example.test"], repo);
    await run(["git", "config", "user.name", "Fixture"], repo);
  }
  await put(join(seed, ".gitignore"), "*.local.md\n");
  await put(join(seed, "agentsmith.toml"), "");
  await put(join(seed, "profiles", "test.toml"), ['harnesses = ["claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
  await put(join(seed, "templates", "base", "default.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(seed, "packs", "base", "pack.toml"), `skills = ["${skill}"]\n`);
  await put(join(seed, "packs", "base", "instructions", "notes", "10-shared.md"), "Shared note.\n");
  await put(join(seed, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Fixture skill.\n---\n\nDo the work.\n`);
  await run(["git", "add", "."], seed);
  expect((await run(["git", "commit", "-m", "source"], seed)).exitCode).toBe(0);
  await run(["git", "remote", "add", "origin", remote], seed);
  expect((await run(["git", "push", "-u", "origin", "HEAD:main"], seed)).exitCode).toBe(0);
  await run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], remote);
  expect((await run(["git", "clone", remote, source], root)).exitCode).toBe(0);
  await run(["git", "config", "user.email", "fixture@example.test"], source);
  await run(["git", "config", "user.name", "Fixture"], source);
  const config = join(root, ".agents", "agentsmith", "config.toml");
  await put(config, `source = ${JSON.stringify(source)}\nprofile = "test"\n`);
  const env = { ...Bun.env, HOME: root, CODEX_HOME: join(root, ".codex") };
  const asmith = async (...args: string[]) => {
    const child = Bun.spawn(["bun", cli, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  const statusFile = join(root, ".agents", "agentsmith", "status.json");
  const readStatus = async () => JSON.parse(await readFile(statusFile, "utf8")) as Record<string, unknown> & { warnings: string[]; backups: unknown[] };
  return {
    root,
    seed,
    source,
    config,
    skill,
    asmith,
    statusFile,
    readStatus,
    instruction: join(root, ".claude", "CLAUDE.md"),
    skillDir: join(root, ".claude", "skills", skill),
  };
}

describe("global reliability", () => {
  test("records status, uses distinct exit codes, and backs up modified artifacts", async () => {
    const fixture = await globalFixture();
    const { asmith, readStatus } = fixture;

    const first = await asmith("global", "sync");
    expect(first.exitCode, first.stderr).toBe(0);
    const success = await readStatus();
    expect(success).toMatchObject({ version: 1, command: "sync", profile: "test", outcome: "success", exitCode: 0, error: null });
    expect(success.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const healthy = await asmith("global", "status", "--max-age", "1h");
    expect(healthy.exitCode, healthy.stderr).toBe(0);
    expect(healthy.stdout).toContain("global sync succeeded");
    const json = await asmith("global", "status", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({ outcome: "success", healthy: true, stale: false });

    // Stored generated content is kept for every recorded artifact.
    const generated = await readFile(fixture.instruction, "utf8");
    const blobs = await readdir(join(fixture.root, ".agents", "agentsmith", "blobs"));
    expect(blobs).toHaveLength(2);

    // A hand edit fails the default sync with the modified-artifact code.
    await writeFile(fixture.instruction, `${generated}\nmanual edit\n`);
    await writeFile(join(fixture.skillDir, "SKILL.md"), `${await readFile(join(fixture.skillDir, "SKILL.md"), "utf8")}\nskill edit\n`);
    const blocked = await asmith("global", "sync");
    expect(blocked.exitCode).toBe(5);
    expect(await readStatus()).toMatchObject({ outcome: "failure", exitCode: 5, error: { code: "artifact-modified" } });
    const failing = await asmith("global", "status");
    expect(failing.exitCode).toBe(5);
    expect(failing.stdout).toContain("global sync failed");

    // Backup mode moves edits aside, regenerates, and records warnings.
    const backedUp = await asmith("global", "sync", "--on-modified=backup");
    expect(backedUp.exitCode, backedUp.stderr).toBe(0);
    expect(backedUp.stderr).toContain("artifact-backup");
    expect(await readFile(fixture.instruction, "utf8")).toBe(generated);
    const backupStatus = await readStatus();
    expect(backupStatus.outcome).toBe("success");
    expect(backupStatus.backups).toHaveLength(2);
    expect(backupStatus.warnings.filter((item) => item.includes("artifact-backup"))).toHaveLength(2);
    const claudeEntries = await readdir(join(fixture.root, ".claude"));
    const instructionBackup = claudeEntries.find((name) => /^CLAUDE\.md\.agentsmith-\d{8}T\d{6}Z$/.test(name));
    expect(instructionBackup).toBeDefined();
    expect(await readFile(join(fixture.root, ".claude", instructionBackup!), "utf8")).toContain("manual edit");
    // Skill directories move outside every skill root so no harness loads a second copy.
    expect((await readdir(join(fixture.root, ".claude", "skills"))).filter((name) => name.includes(".agentsmith-"))).toEqual([]);
    const backupRoot = join(fixture.root, ".agents", "agentsmith", "backups");
    const [stamp] = await readdir(backupRoot);
    expect(await readFile(join(backupRoot, stamp!, fixture.skillDir.slice(1), "SKILL.md"), "utf8")).toContain("skill edit");
    expect(await readFile(join(fixture.skillDir, "SKILL.md"), "utf8")).not.toContain("skill edit");

    // A stale successful run fails a max-age check.
    await writeFile(fixture.statusFile, JSON.stringify({ ...backupStatus, timestamp: "2026-01-01T00:00:00.000Z" }));
    expect((await asmith("global", "status", "--max-age", "1d")).exitCode).toBe(6);
    expect((await asmith("global", "status", "--max-age", "soon")).exitCode).toBe(2);

    // Dirty Source Repository.
    await writeFile(join(fixture.source, "stray.md"), "stray\n");
    const dirty = await asmith("global", "sync");
    expect(dirty.exitCode).toBe(3);
    expect(await readStatus()).toMatchObject({ outcome: "failure", error: { code: "source-dirty" } });
    await rm(join(fixture.source, "stray.md"));

    // Non-fast-forward pull.
    await put(join(fixture.seed, "upstream.md"), "upstream\n");
    await run(["git", "add", "."], fixture.seed);
    await run(["git", "commit", "-m", "upstream"], fixture.seed);
    expect((await run(["git", "push", "origin", "HEAD:main"], fixture.seed)).exitCode).toBe(0);
    await put(join(fixture.source, "local.md"), "local\n");
    await run(["git", "add", "."], fixture.source);
    await run(["git", "commit", "-m", "local"], fixture.source);
    const diverged = await asmith("global", "sync");
    expect(diverged.exitCode).toBe(4);
    expect(await readStatus()).toMatchObject({ outcome: "failure", error: { code: "source-pull" } });

    // Configuration error.
    await writeFile(fixture.config, `source = ${JSON.stringify(fixture.source)}\nprofile = "missing"\n`);
    const misconfigured = await asmith("global", "generate");
    expect(misconfigured.exitCode).toBe(2);
    expect(await readStatus()).toMatchObject({ command: "generate", outcome: "failure", error: { code: "config" } });
  });

  test("adopts prepended and appended edits and refuses other edits", async () => {
    const fixture = await globalFixture();
    const { asmith } = fixture;
    expect((await asmith("global", "generate")).exitCode).toBe(0);
    const generated = await readFile(fixture.instruction, "utf8");
    const edited = `Machine-local preface.\n\n${generated}\n## Local\n\nMachine-local appendix.\n`;
    await writeFile(fixture.instruction, edited);
    expect((await asmith("global", "generate")).exitCode).toBe(5);

    const prepend = join(fixture.source, "packs", "base", "instructions", "claude", "prepend", "00-adopted.local.md");
    const append = join(fixture.source, "packs", "base", "instructions", "claude", "append", "99-adopted.local.md");
    const dryRun = await asmith("global", "adopt", "--dry-run");
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain("Would adopt");
    expect(await Bun.file(prepend).exists()).toBeFalse();

    // A snippet path Git would track is refused because it would block sync.
    await writeFile(join(fixture.source, ".gitignore"), "");
    const tracked = await asmith("global", "adopt");
    expect(tracked.exitCode).toBe(2);
    expect(tracked.stderr).toContain("not ignored by Git");
    await run(["git", "checkout", "--", ".gitignore"], fixture.source);

    const adopted = await asmith("global", "adopt");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(await readFile(prepend, "utf8")).toBe("Machine-local preface.\n\n");
    expect(await readFile(append, "utf8")).toBe("\n## Local\n\nMachine-local appendix.\n");
    expect(await readFile(fixture.instruction, "utf8")).toBe(edited);
    expect((await run(["git", "status", "--porcelain"], fixture.source)).stdout).toBe("");

    const regenerated = await asmith("global", "generate");
    expect(regenerated.exitCode, regenerated.stderr).toBe(0);
    expect(await readFile(fixture.instruction, "utf8")).toBe(edited);
    expect((await asmith("global", "sync")).exitCode).toBe(0);

    // A second round accumulates in the same snippets in document order.
    await writeFile(fixture.instruction, `Newer preface.\n${edited}Newer appendix.\n`);
    expect((await asmith("global", "adopt")).exitCode).toBe(0);
    expect(await readFile(prepend, "utf8")).toBe("Newer preface.\nMachine-local preface.\n\n");
    expect((await asmith("global", "generate")).exitCode).toBe(0);
    expect(await readFile(fixture.instruction, "utf8")).toBe(`Newer preface.\n${edited}Newer appendix.\n`);

    // Mid-file edits and skill edits are refused without changing anything.
    const current = await readFile(fixture.instruction, "utf8");
    const middle = current.replace("Shared note.", "Shared note, edited.");
    await writeFile(fixture.instruction, middle);
    const refused = await asmith("global", "adopt");
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain("not strictly before or after");
    expect(await readFile(fixture.instruction, "utf8")).toBe(middle);
    await writeFile(fixture.instruction, current);
    await writeFile(join(fixture.skillDir, "SKILL.md"), "edited skill\n");
    const skillRefused = await asmith("global", "adopt");
    expect(skillRefused.exitCode).toBe(5);
    expect(skillRefused.stderr).toContain("skill artifacts are never adopted");
  });

  test("adopts both parts into an explicit slot", async () => {
    const fixture = await globalFixture();
    const { asmith } = fixture;
    expect((await asmith("global", "generate")).exitCode).toBe(0);
    const generated = await readFile(fixture.instruction, "utf8");
    await writeFile(fixture.instruction, `Before.\n${generated}After.\n`);
    const adopted = await asmith("global", "adopt", "--slot", "notes", "--pack", "base");
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(await readFile(join(fixture.source, "packs", "base", "instructions", "claude", "notes", "99-adopted.local.md"), "utf8")).toBe("Before.\nAfter.\n");
    const content = await readFile(fixture.instruction, "utf8");
    expect(content).toBe("# Global\n\nShared note.\n\nBefore.\nAfter.\n");
    expect((await asmith("global", "generate")).exitCode).toBe(0);
  });
});
