import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chooseSnippetNumber, choosePack, resolveSlot, snippetFileName, snippetPrefix, snippetSlug, slugify } from "../src/add.ts";
import type { SlotTarget } from "../src/planner.ts";

const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

describe("snippet numbering", () => {
  const names = (...prefixes: string[]) => prefixes.map((prefix) => `${prefix}-x.md`);

  test("gap goes directly after the lower neighbor of the largest gap", () => {
    expect(chooseSnippetNumber(names("00", "10", "11", "99"))).toMatchObject({ number: 12 });
    expect(chooseSnippetNumber(names("00", "10", "11", "99")).reason).toContain("gap");
    expect(chooseSnippetNumber(names("10", "20")).number).toBe(21);
    expect(chooseSnippetNumber(names("10")).number).toBe(11);
    expect(chooseSnippetNumber(names("90", "99")).number).toBe(91);
  });

  test("ties take the lowest gap", () => {
    expect(chooseSnippetNumber(names("00", "10", "20", "30", "40", "50", "60", "70", "80", "90")).number).toBe(1);
    expect(chooseSnippetNumber(names("00", "50")).number).toBe(1);
    expect(chooseSnippetNumber(names("00", "49", "99")).number).toBe(50);
  });

  test("an empty slot starts at 50 for every placement", () => {
    for (const placement of ["gap", "first", "last"] as const) expect(chooseSnippetNumber([], placement).number).toBe(50);
    expect(chooseSnippetNumber([]).reason).toContain("empty slot");
  });

  test("no free number after an existing prefix is an error", () => {
    const full = Array.from({ length: 50 }, (_, index) => `${50 + index}-x.md`);
    expect(() => chooseSnippetNumber(full)).toThrow("--placement first");
    const all = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(2, "0")}-x.md`);
    expect(() => chooseSnippetNumber(all)).toThrow("No number is free");
  });

  test("first and last go directly below the lowest and above the highest prefix", () => {
    expect(chooseSnippetNumber(names("10", "20"), "first")).toMatchObject({ number: 9 });
    expect(chooseSnippetNumber(names("10", "20"), "last")).toMatchObject({ number: 21 });
    expect(() => chooseSnippetNumber(names("00", "20"), "first")).toThrow("below the lowest prefix 00");
    expect(() => chooseSnippetNumber(names("10", "99"), "last")).toThrow("above the highest prefix 99");
  });

  test("entries without a two-digit prefix are ignored", () => {
    expect(snippetPrefix("10-a.md")).toBe(10);
    expect(snippetPrefix("100-a.md")).toBeUndefined();
    expect(snippetPrefix("5-a.md")).toBeUndefined();
    expect(snippetPrefix("notes.md")).toBeUndefined();
    expect(chooseSnippetNumber(["notes.md", "README", "7-x.md"]).number).toBe(50);
    expect(chooseSnippetNumber(["10-a.md", "zz.md", "00-adopted.local.md"]).number).toBe(11);
    expect(chooseSnippetNumber(["10-a.md", "10-b.local.md"]).number).toBe(11);
  });
});

describe("snippet names", () => {
  test("slug from the first line with text", () => {
    expect(snippetSlug("\n## Prefer small, focused commits!\n\nBody.\n")).toBe("prefer-small-focused-commits");
    expect(snippetSlug("Über café naïve\n")).toBe("uber-cafe-naive");
    expect(snippetSlug("one two three four five six seven eight\n")).toBe("one-two-three-four-five-six");
    expect(snippetSlug("---\n```\n")).toBe("snippet");
    expect(slugify("a".repeat(60))).toHaveLength(48);
  });

  test("--name is slugified and must contain letters or digits", () => {
    expect(snippetSlug("ignored", "Testing Rules")).toBe("testing-rules");
    expect(snippetSlug("ignored", "testing.local.md")).toBe("testing");
    expect(() => snippetSlug("ignored", "!!!")).toThrow("--name");
  });

  test("file names", () => {
    expect(snippetFileName(7, "note")).toBe("07-note.md");
    expect(snippetFileName(50, "note", true)).toBe("50-note.local.md");
  });
});

describe("pack choice", () => {
  test("is required unless exactly one candidate exists", () => {
    expect(choosePack(["base"], undefined, "selected")).toBe("base");
    expect(choosePack(["source:base"], undefined, "selected")).toBe("base");
    expect(() => choosePack(["base", "extra"], undefined, "selected by profile p")).toThrow("--pack is required");
    expect(() => choosePack([], undefined, "selected")).toThrow("There is no pack");
    expect(choosePack(["base", "extra"], "extra", "selected")).toBe("extra");
    expect(() => choosePack(["base"], "other", "selected")).toThrow("Pack other is not selected");
  });
});

describe("slot resolution", () => {
  const targets: SlotTarget[] = [
    { kind: "instruction", scope: ".", destination: "/p/AGENTS.md", harnesses: ["generic", "codex"], slots: ["append", "notes", "prepend"] },
    { kind: "instruction", scope: ".", destination: "/p/CLAUDE.md", harnesses: ["claude"], slots: ["append", "notes", "prepend", "special"] },
    { kind: "skill", scope: ".", destination: "/p/.agents/skills/a", harnesses: ["generic", "codex"], skill: "a", slots: ["checks"] },
    { kind: "skill", scope: ".", destination: "/p/.claude/skills/a", harnesses: ["claude"], exclusiveReader: "claude", skill: "a", slots: ["checks"] },
    { kind: "skill", scope: ".", destination: "/p/.claude/skills/b", harnesses: ["claude"], exclusiveReader: "claude", skill: "b", slots: [] },
  ];
  const plan = { mode: "project" as const, slotTargets: targets };
  const resolve = (slot: string, extra: { skillSlot?: boolean; harness?: "generic" | "codex" | "claude" } = {}) =>
    resolveSlot(plan, { slot, scope: ".", scopeLabel: "scope .", ...extra });

  test("instruction slots", () => {
    expect(resolve("notes").receivers).toHaveLength(2);
    expect(resolve("prepend").receivers).toHaveLength(2);
    expect(() => resolve("missing")).toThrow("Slots: append, notes, prepend, special");
    expect(() => resolve("special")).toThrow("pass --harness claude");
    expect(resolve("special", { harness: "claude" }).receivers.map((item) => item.destination)).toEqual(["/p/CLAUDE.md"]);
    expect(() => resolve("special", { harness: "codex" })).toThrow("Slots: append, notes, prepend");
  });

  test("skill slots", () => {
    expect(resolve("checks", { skillSlot: true }).receivers.map((item) => item.skill)).toEqual(["a", "a"]);
    expect(resolve("checks", { skillSlot: true, harness: "claude" }).receivers.map((item) => item.destination)).toEqual(["/p/.claude/skills/a"]);
    expect(() => resolve("checks", { skillSlot: true, harness: "codex" })).toThrow("read only by codex");
    expect(() => resolve("other", { skillSlot: true })).toThrow("Skill slots: checks");
  });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

async function git(cwd: string, ...args: string[]) {
  const result = await run(["git", ...args], cwd);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout;
}

function cliRunner(root: string, env: Record<string, string | undefined>) {
  return async (args: string[], options: { cwd?: string; stdin?: string } = {}) => {
    const child = Bun.spawn(["bun", cli, ...args], {
      cwd: options.cwd ?? root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
}

async function globalFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-add-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const source = join(root, "source");
  await mkdir(seed, { recursive: true });
  await git(root, "init", "--bare", remote);
  await git(seed, "init");
  await git(seed, "config", "user.email", "fixture@example.test");
  await git(seed, "config", "user.name", "Fixture");
  await put(join(seed, ".gitignore"), "*.local.md\n");
  await put(join(seed, "agentsmith.toml"), "");
  await put(join(seed, "profiles", "test.toml"), ['harnesses = ["generic", "codex", "claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
  await put(join(seed, "templates", "base", "default.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n");
  await put(join(seed, "templates", "base", "claude.md"), "# Global\n\n<!-- agentsmith:slot notes -->\n\n## Claude\n\n<!-- agentsmith:slot claude-only -->\n");
  await put(join(seed, "packs", "base", "pack.toml"), 'skills = ["fixture-skill", "plain-skill"]\n');
  await put(join(seed, "packs", "base", "instructions", "notes", "10-shared.md"), "Shared note.\n");
  await put(join(seed, "packs", "extra", "pack.toml"), "");
  await put(
    join(seed, "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Fixture skill.\n---\n\n# Fixture\n\n<!-- agentsmith:slot checks -->\n",
  );
  await put(join(seed, "skills", "plain-skill", "SKILL.md"), "---\nname: plain-skill\ndescription: Plain skill.\n---\n\nPlain.\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "source");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "HEAD:main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(root, "clone", remote, source);
  await git(source, "config", "user.email", "fixture@example.test");
  await git(source, "config", "user.name", "Fixture");
  await put(join(root, ".agents", "agentsmith", "config.toml"), `source = ${JSON.stringify(source)}\nprofile = "test"\n`);
  const asmith = cliRunner(root, { ...Bun.env, HOME: root, CODEX_HOME: join(root, ".codex") });
  const generated = await asmith(["global", "generate"]);
  expect(generated.exitCode, generated.stderr).toBe(0);
  return {
    root,
    remote,
    seed,
    source,
    asmith,
    notes: join(source, "packs", "base", "instructions", "notes"),
    claude: join(root, ".claude", "CLAUDE.md"),
    codex: join(root, ".codex", "AGENTS.md"),
  };
}

describe("global add", () => {
  test("adds text, --file, and stdin snippets and regenerates", async () => {
    const f = await globalFixture();
    const added = await f.asmith(["global", "add", "notes", "Prefer small commits."]);
    expect(added.exitCode, added.stderr).toBe(0);
    const path = join(f.notes, "11-prefer-small-commits.md");
    expect(added.stdout).toContain(path);
    expect(added.stdout).toContain("number 11: gap, directly after 10");
    expect(added.stdout).toContain("not committed");
    expect(await readFile(path, "utf8")).toBe("Prefer small commits.\n");
    expect(await readFile(f.claude, "utf8")).toContain("Shared note.\n\nPrefer small commits.");
    expect(await readFile(f.codex, "utf8")).toContain("Prefer small commits.");
    const status = JSON.parse(await readFile(join(f.root, ".agents", "agentsmith", "status.json"), "utf8"));
    expect(status).toMatchObject({ command: "generate", outcome: "success" });

    await put(join(f.root, "snippet.md"), "## Reviews\n\nAsk for review early.\n");
    const fromFile = await f.asmith(["global", "add", "notes", "--file", join(f.root, "snippet.md"), "--placement", "first"]);
    expect(fromFile.exitCode, fromFile.stderr).toBe(0);
    expect(await readFile(join(f.notes, "09-reviews.md"), "utf8")).toBe("## Reviews\n\nAsk for review early.\n");

    const fromStdin = await f.asmith(["global", "add", "notes", "--name", "Piped Note", "--placement", "last"], { stdin: "From stdin." });
    expect(fromStdin.exitCode, fromStdin.stderr).toBe(0);
    expect(await readFile(join(f.notes, "12-piped-note.md"), "utf8")).toBe("From stdin.\n");
    expect(await readFile(f.claude, "utf8")).toContain("From stdin.");

    const both = await f.asmith(["global", "add", "notes", "text", "--file", join(f.root, "snippet.md")]);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain("not both");
    const empty = await f.asmith(["global", "add", "notes"]);
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain("empty");
  });

  test("validates instruction slots against the selected templates and --harness", async () => {
    const f = await globalFixture();
    const unknown = await f.asmith(["global", "add", "nope", "Text."]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("Slots: append, claude-only, notes, prepend");

    const partial = await f.asmith(["global", "add", "claude-only", "Text."]);
    expect(partial.exitCode).toBe(2);
    expect(partial.stderr).toContain("pass --harness claude");

    const specific = await f.asmith(["global", "add", "claude-only", "Claude text.", "--harness", "claude"]);
    expect(specific.exitCode, specific.stderr).toBe(0);
    expect(existsSync(join(f.source, "packs", "base", "instructions", "claude", "claude-only", "50-claude-text.md"))).toBeTrue();
    expect(await readFile(f.claude, "utf8")).toContain("Claude text.");
    expect(await readFile(f.codex, "utf8")).not.toContain("Claude text.");

    const wrongHarness = await f.asmith(["global", "add", "claude-only", "Text.", "--harness", "codex"]);
    expect(wrongHarness.exitCode).toBe(2);
    expect(wrongHarness.stderr).toContain("Slots: append, notes, prepend");

    const noLayer = await f.asmith(["global", "add", "notes", "Text.", "--harness", "generic"]);
    expect(noLayer.exitCode).toBe(2);
    expect(noLayer.stderr).toContain("no Instruction Layer for generic");

    const edge = await f.asmith(["global", "add", "prepend", "Top line.", "--harness", "claude"]);
    expect(edge.exitCode, edge.stderr).toBe(0);
    expect((await readFile(f.claude, "utf8")).startsWith("Top line.\n# Global")).toBeTrue();
  });

  test("skill slots list receiving skills and require a declaring skill", async () => {
    const f = await globalFixture();
    const added = await f.asmith(["global", "add", "checks", "Run the tests.", "--skill-slot"]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain("receiving skills: fixture-skill");
    expect(added.stdout).not.toContain("plain-skill");
    expect(existsSync(join(f.source, "packs", "base", "skill-slots", "checks", "50-run-the-tests.md"))).toBeTrue();
    expect(await readFile(join(f.root, ".claude", "skills", "fixture-skill", "SKILL.md"), "utf8")).toContain("Run the tests.");
    expect(await readFile(join(f.root, ".agents", "skills", "fixture-skill", "SKILL.md"), "utf8")).toContain("Run the tests.");

    const specific = await f.asmith(["global", "add", "checks", "Claude checks.", "--skill-slot", "--harness", "claude"]);
    expect(specific.exitCode, specific.stderr).toBe(0);
    expect(existsSync(join(f.source, "packs", "base", "skill-slots", "harnesses", "claude", "checks", "50-claude-checks.md"))).toBeTrue();
    expect(await readFile(join(f.root, ".claude", "skills", "fixture-skill", "SKILL.md"), "utf8")).toContain("Claude checks.");
    expect(await readFile(join(f.root, ".agents", "skills", "fixture-skill", "SKILL.md"), "utf8")).not.toContain("Claude checks.");

    const shared = await f.asmith(["global", "add", "checks", "Codex checks.", "--skill-slot", "--harness", "codex"]);
    expect(shared.exitCode).toBe(2);
    expect(shared.stderr).toContain("read only by codex");

    const none = await f.asmith(["global", "add", "missing", "Text.", "--skill-slot"]);
    expect(none.exitCode).toBe(2);
    expect(none.stderr).toContain("declares skill slot missing. Skill slots: checks");
  });

  test("--local requires a Git-ignored snippet", async () => {
    const f = await globalFixture();
    const local = await f.asmith(["global", "add", "notes", "Machine only.", "--local"]);
    expect(local.exitCode, local.stderr).toBe(0);
    expect(await readFile(join(f.notes, "11-machine-only.local.md"), "utf8")).toBe("Machine only.\n");
    expect(local.stdout).not.toContain("not committed");
    expect(await git(f.source, "status", "--porcelain")).toBe("");
    expect(await readFile(f.claude, "utf8")).toContain("Machine only.");

    await writeFile(join(f.source, ".gitignore"), "");
    const tracked = await f.asmith(["global", "add", "notes", "Not ignored.", "--local"]);
    expect(tracked.exitCode).toBe(2);
    expect(tracked.stderr).toContain("not ignored by Git");
    expect(await readdir(f.notes)).toEqual(["10-shared.md", "11-machine-only.local.md"]);
  });

  test("--pack is required with several candidate packs, for add and adopt", async () => {
    const f = await globalFixture();
    await writeFile(
      join(f.source, "profiles", "test.toml"),
      ['harnesses = ["generic", "codex", "claude"]', 'template = "base"', 'packs = ["base", "extra"]', ""].join("\n"),
    );
    const ambiguous = await f.asmith(["global", "add", "notes", "Text."]);
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.stderr).toContain("--pack is required");
    expect(ambiguous.stderr).toContain("base, extra");
    const chosen = await f.asmith(["global", "add", "notes", "Extra text.", "--pack", "extra", "--skip-generate"]);
    expect(chosen.exitCode, chosen.stderr).toBe(0);
    expect(existsSync(join(f.source, "packs", "extra", "instructions", "notes", "50-extra-text.md"))).toBeTrue();
    const unselected = await f.asmith(["global", "add", "notes", "Text.", "--pack", "other"]);
    expect(unselected.exitCode).toBe(2);
    expect(unselected.stderr).toContain("Pack other is not selected by profile test");

    const generated = await f.asmith(["global", "generate"]);
    expect(generated.exitCode, generated.stderr).toBe(0);
    await writeFile(f.claude, `Preface.\n${await readFile(f.claude, "utf8")}`);
    const adopt = await f.asmith(["global", "adopt"]);
    expect(adopt.exitCode).toBe(2);
    expect(adopt.stderr).toContain("--pack is required");
    const adopted = await f.asmith(["global", "adopt", "--pack", "base"]);
    expect(adopted.exitCode, adopted.stderr).toBe(0);
  });

  test("rolls back a snippet that fails lint, and honors --skip-generate and --dry-run", async () => {
    const f = await globalFixture();
    const before = await readFile(f.claude, "utf8");
    const broken = await f.asmith(["global", "add", "claude-only", "<!-- agentsmith:include missing.md -->", "--harness", "claude"]);
    expect(broken.exitCode).toBe(2);
    expect(broken.stderr).toContain("Lint failed; removed");
    expect(existsSync(join(f.source, "packs", "base", "instructions", "claude"))).toBeFalse();
    expect(await readFile(f.claude, "utf8")).toBe(before);

    const skipped = await f.asmith(["global", "add", "notes", "Later.", "--skip-generate"]);
    expect(skipped.exitCode, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain("skipped regeneration");
    expect(existsSync(join(f.notes, "11-later.md"))).toBeTrue();
    expect(await readFile(f.claude, "utf8")).toBe(before);

    const dry = await f.asmith(["global", "add", "notes", "Dry content.", "--dry-run"]);
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`Would add ${join(f.notes, "12-dry-content.md")}`);
    expect(dry.stdout).toContain("Dry content.");
    expect(existsSync(join(f.notes, "12-dry-content.md"))).toBeFalse();
  });

  test("--push pulls, commits only the new file, pushes, and regenerates", async () => {
    const f = await globalFixture();
    // An upstream change the add must fast-forward onto.
    await put(join(f.seed, "packs", "base", "instructions", "notes", "20-upstream.md"), "Upstream note.\n");
    await git(f.seed, "add", ".");
    await git(f.seed, "commit", "-m", "upstream");
    await git(f.seed, "push", "origin", "HEAD:main");

    const pushed = await f.asmith(["global", "add", "notes", "Pushed note.", "--push"]);
    expect(pushed.exitCode, pushed.stderr).toBe(0);
    // 10 and 20 exist after the pull; the largest gap is above 20.
    const relativePath = "packs/base/instructions/notes/21-pushed-note.md";
    expect(await git(f.source, "show", "--name-only", "--format=", "HEAD")).toBe(`${relativePath}\n`);
    expect(await git(f.remote, "show", "--name-only", "--format=", "main")).toBe(`${relativePath}\n`);
    expect(await git(f.source, "status", "--porcelain")).toBe("");
    expect(await readFile(f.claude, "utf8")).toContain("Upstream note.\n\nPushed note.");

    const withLocal = await f.asmith(["global", "add", "notes", "Text.", "--push", "--local"]);
    expect(withLocal.exitCode).toBe(2);

    await put(join(f.source, "stray.md"), "stray\n");
    const dirty = await f.asmith(["global", "add", "notes", "Text.", "--push"]);
    expect(dirty.exitCode).toBe(3);
    expect(await readdir(f.notes)).not.toContain("22-text.md");
    await Bun.file(join(f.source, "stray.md")).delete();

    // A rejected push keeps the local commit and says so.
    await put(join(f.remote, "hooks", "pre-receive"), "#!/bin/sh\necho rejected by fixture >&2\nexit 1\n");
    await run(["chmod", "+x", join(f.remote, "hooks", "pre-receive")], f.root);
    const remoteHead = await git(f.remote, "rev-parse", "main");
    const rejected = await f.asmith(["global", "add", "notes", "Rejected note.", "--push"]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("push failed; the commit is kept");
    expect(await git(f.source, "show", "--name-only", "--format=", "HEAD")).toBe("packs/base/instructions/notes/22-rejected-note.md\n");
    expect(await git(f.remote, "rev-parse", "main")).toBe(remoteHead);
  });
});

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-add-project-"));
  const project = join(root, "project");
  const config = join(project, ".config", "agentsmith");
  await put(
    join(config, "config.toml"),
    [
      'harnesses = ["generic", "codex", "claude"]',
      "",
      "[[scopes]]",
      'path = "."',
      'template = "base"',
      'packs = ["local", "shared"]',
      "",
      "[[scopes]]",
      'path = "app"',
      'template = "base"',
      'packs = ["app"]',
      'harnesses = ["claude"]',
      "",
    ].join("\n"),
  );
  await put(join(config, "templates", "base", "default.md"), "# Project\n\n<!-- agentsmith:slot notes -->\n");
  for (const pack of ["local", "shared", "app"]) await put(join(config, "packs", pack, "pack.toml"), "");
  await put(join(project, "app", "README.md"), "app\n");
  await git(project, "init");
  await git(project, "config", "user.email", "fixture@example.test");
  await git(project, "config", "user.name", "Fixture");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "fixture");
  const asmith = cliRunner(project, { ...Bun.env, HOME: root, CODEX_HOME: join(root, ".codex") });
  return { root, project, packs: join(config, "packs"), asmith };
}

describe("project add", () => {
  test("adds to project packs of the selected scope and follows project safety", async () => {
    const f = await projectFixture();
    const ambiguous = await f.asmith(["project", "add", "notes", "Text."]);
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.stderr).toContain("--pack is required");
    expect(ambiguous.stderr).toContain("local, shared");

    const added = await f.asmith(["project", "add", "notes", "Use the project fixture.", "--pack", "local"]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(existsSync(join(f.packs, "local", "instructions", "notes", "50-use-the-project-fixture.md"))).toBeTrue();
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toContain("Use the project fixture.");

    // The app scope is the default from inside app/ and has one project pack.
    const app = await f.asmith(["project", "add", "notes", "App note.", "--skip-generate"], { cwd: join(f.project, "app") });
    expect(app.exitCode, app.stderr).toBe(0);
    expect(existsSync(join(f.packs, "app", "instructions", "notes", "50-app-note.md"))).toBeTrue();
    const unselected = await f.asmith(["project", "add", "notes", "Text.", "--harness", "codex"], { cwd: join(f.project, "app") });
    expect(unselected.exitCode).toBe(2);
    expect(unselected.stderr).toContain("Harness codex is not selected by scope app");
    const explicit = await f.asmith(["project", "add", "notes", "Root again.", "--scope", ".", "--pack", "shared", "--dry-run"], {
      cwd: join(f.project, "app"),
    });
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    expect(explicit.stdout).toContain(join(f.packs, "shared", "instructions", "notes", "50-root-again.md"));
    expect((await f.asmith(["project", "add", "notes", "Text.", "--scope", "missing"])).stderr).toContain("Scope missing is not declared");

    // Generated outputs are untracked now, so project safety refuses regeneration; the snippet stays.
    const refused = await f.asmith(["project", "add", "notes", "Second note.", "--pack", "local", "--project", f.project], { cwd: f.root });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("regeneration failed; the snippet was kept");
    expect(refused.stderr).toContain("untracked project destination");
    expect(existsSync(join(f.packs, "local", "instructions", "notes", "51-second-note.md"))).toBeTrue();

    for (const flag of ["--push", "--local"]) {
      const globalOnly = await f.asmith(["project", "add", "notes", "Text.", "--pack", "local", flag]);
      expect(globalOnly.exitCode).toBe(2);
      expect(globalOnly.stderr).toContain("only supported by global add");
    }
  });
});
