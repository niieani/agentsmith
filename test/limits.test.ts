import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfileConfig, loadProjectConfig, loadRootConfig } from "../src/config.ts";
import { claudeImports, HARNESS_LIMITS, LOAD_MODELS } from "../src/limits.ts";
import { assertPlanValid, buildGlobalPlan, buildProjectPlan } from "../src/planner.ts";
import { frontMatterFields } from "../src/skills.ts";
import { HARNESS_NAMES, type Diagnostic } from "../src/types.ts";
import { cli, commitAll, projectFixture, put, run } from "./support/project.ts";

interface Setup {
  root: string;
  project: string;
  home: string;
  source: string;
  machine: string;
}

/** A project under `<root>/project` and a machine config whose sandbox home is `<root>/home`. */
async function setup(config: string[], files: Record<string, string> = {}): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-limits-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const source = join(root, "source");
  const machine = join(root, "machine.toml");
  await mkdir(home, { recursive: true });
  await put(join(source, "agentsmith.toml"), "");
  await put(machine, `source = ${JSON.stringify(source)}\nprofile = "unused"\nhome = ${JSON.stringify(home)}\n`);
  await put(join(project, ".config", "agentsmith", "config.toml"), `${config.join("\n")}\n`);
  for (const [path, content] of Object.entries(files)) await put(join(root, path), content);
  return { root, project, home, source, machine };
}

const scope = (path: string, template = "guide", packs: string[] = []) => [
  "[[scopes]]",
  `path = ${JSON.stringify(path)}`,
  `template = ${JSON.stringify(template)}`,
  `packs = ${JSON.stringify(packs)}`,
];

const lines = (count: number, prefix = "Line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}.`).join("\n");
const skill = (name: string, description: string, extra = "", body = "Body.") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
const limitDiagnostics = (diagnostics: Diagnostic[], code: string) => diagnostics.filter((item) => item.code === code);

describe("per-harness limit table", () => {
  test("every limit has a unique key, a load model where it needs one, and no limit for generic", () => {
    for (const harness of HARNESS_NAMES) {
      const keys = (HARNESS_LIMITS[harness] ?? []).map((limit) => limit.key);
      expect(new Set(keys).size).toBe(keys.length);
      const needsModel = (HARNESS_LIMITS[harness] ?? []).some((limit) => ["instruction-file", "import-depth", "instruction-chain"].includes(limit.kind));
      if (needsModel) expect(LOAD_MODELS[harness]).toBeDefined();
    }
    expect(HARNESS_LIMITS.generic).toBeUndefined();
  });

  test("finds @imports outside code", () => {
    expect(claudeImports("@AGENTS.md\nSee @docs/a.md and `@not.md`.\n```\n@fenced.md\n```\nmail me@example.com\n")).toEqual(["AGENTS.md", "docs/a.md"]);
  });

  test("reads folded, literal, and continued front matter fields", () => {
    const fields = frontMatterFields(
      "---\nname: x\ndescription: >\n  one\n  two\nwhen_to_use: |\n  a\n  b\nplain: first\n  second\nlist:\n  - item\n---\nbody\n",
    );
    expect(fields).toEqual({ name: "x", description: "one two", when_to_use: "a\nb", plain: "first second" });
  });
});

describe("[budgets.<harness>] configuration", () => {
  test("parses overrides beside the shared budget keys and merges them through profiles", async () => {
    const { source } = await setup([]);
    await put(
      join(source, "agentsmith.toml"),
      "[budgets]\ninstruction_layer_bytes = 100\n[budgets.codex]\nproject_doc_bytes = 65536\nskill_listing_chars = 9000\n",
    );
    expect(loadRootConfig(source).budgets).toEqual({
      instructionLayerBytes: 100,
      harnesses: { codex: { project_doc_bytes: 65536, skill_listing_chars: 9000 } },
    });
    await put(
      join(source, "profiles", "base.toml"),
      'harnesses = ["codex"]\ntemplate = "t"\n[budgets.codex]\nproject_doc_bytes = 1000\nskill_name_chars = 80\n',
    );
    await put(join(source, "profiles", "leaf.toml"), 'extends = "base"\n[budgets.codex]\nproject_doc_bytes = 2000\n[budgets.claude]\nimport_depth = 5\n');
    expect(loadProfileConfig(source, "leaf").budgets.harnesses).toEqual({
      codex: { project_doc_bytes: 2000, skill_name_chars: 80 },
      claude: { import_depth: 5 },
    });
  });

  test.each([
    ["[budgets.nope]\nimport_depth = 1\n", 'unknown harness "nope"'],
    ["[budgets.claude-code]\nimport_depth = 1\n", 'renamed to "claude"'],
    ["[budgets.claude]\nproject_doc_bytes = 1\n", "unknown budgets.claude key: project_doc_bytes"],
    ["[budgets.generic]\n", 'harness "generic", which has no built-in limits'],
    ["[budgets.codex]\nproject_doc_bytes = 0\n", "budgets.codex.project_doc_bytes must be a positive integer"],
    ["[budgets]\nnope = 1\n", "unknown budgets key: nope"],
  ])("rejects %p", async (budgets, message) => {
    const { project } = await setup([]);
    await put(join(project, ".config", "agentsmith", "config.toml"), `harnesses = ["codex"]\n${scope(".").join("\n")}\n${budgets}`);
    expect(() => loadProjectConfig(join(project, ".config", "agentsmith", "config.toml"))).toThrow(message);
  });
});

describe("Codex limits", () => {
  test("warns when the project AGENTS.md chain passes 32 KiB, counting each directory's file once", async () => {
    const big = "x".repeat(20 * 1024);
    const s = await setup(['harnesses = ["codex"]', ...scope("."), ...scope("app")], {
      "project/.config/agentsmith/templates/guide/default.md": `# Guide\n\n${big}\n`,
      "project/app/README.md": "app\n",
    });
    const plan = await buildProjectPlan(s.project, s.machine);
    const found = limitDiagnostics(plan.diagnostics, "codex-project-doc-bytes");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.message).toContain(
      `Codex: the instruction files loaded at scope app (${join(s.project, "AGENTS.md")}, ${join(s.project, "app", "AGENTS.md")}) are 40,980 bytes, over the 32,768-byte limit`,
    );
    expect(found[0]!.message).toContain("truncates the file that crosses the limit and skips every later file");
    expect(found[0]!.message).toContain("budgets.codex.project_doc_bytes");
    expect(plan.diagnostics.some((item) => item.code === "codex-default-instruction-cap")).toBeFalse();
  });

  test("counts AGENTS.override.md instead of the AGENTS.md it replaces, and honors an override", async () => {
    const s = await setup(['harnesses = ["codex"]', ...scope(".", "guide", ["mine"])], {
      "project/.config/agentsmith/templates/guide/default.md": "# Guide\n\n<!-- agentsmith:slot notes -->\n",
      "source/packs/mine/instructions/notes/10-big.md": `${"y".repeat(40 * 1024)}\n`,
    });
    const plan = await buildProjectPlan(s.project, s.machine);
    const [found] = limitDiagnostics(plan.diagnostics, "codex-project-doc-bytes");
    expect(found?.message).toContain(join(s.project, "AGENTS.override.md"));
    expect(found?.message).not.toContain(`${join(s.project, "AGENTS.md")}`);

    await put(
      join(s.project, ".config", "agentsmith", "config.toml"),
      `harnesses = ["codex"]\n${scope(".", "guide", ["mine"]).join("\n")}\n[budgets.codex]\nproject_doc_bytes = 65536\n`,
    );
    expect(limitDiagnostics((await buildProjectPlan(s.project, s.machine)).diagnostics, "codex-project-doc-bytes")).toEqual([]);
  });

  test("reports long names, long descriptions, and a full description budget across global and project skills", async () => {
    const longName = `n${"a".repeat(64)}`;
    const files: Record<string, string> = {
      "project/.config/agentsmith/templates/guide/default.md": "# Guide\n",
      [`project/.config/agentsmith/skills/${longName}/SKILL.md`]: skill(longName, "Short."),
      "project/.config/agentsmith/skills/wordy/SKILL.md": skill("wordy", "w".repeat(1100)),
    };
    // Unmanaged global skills count toward the budget too.
    for (let index = 0; index < 7; index++) files[`home/.agents/skills/g${index}/SKILL.md`] = skill(`g${index}`, "d".repeat(1000));
    const s = await setup(['harnesses = ["generic", "codex"]', ...scope("."), `skills_enable = ["${longName}", "wordy"]`], files);
    const plan = await buildProjectPlan(s.project, s.machine);

    const [name] = limitDiagnostics(plan.diagnostics, "codex-skill-name-chars");
    expect(name?.severity).toBe("error");
    expect(name?.message).toContain(
      `skill ${longName} at ${join(s.project, ".agents", "skills", longName)} has a name of 65 characters, over the 64-character limit`,
    );
    expect(name?.message).toContain("fails to parse the skill and does not load it");

    const [description] = limitDiagnostics(plan.diagnostics, "codex-skill-description-chars");
    expect(description?.severity).toBe("warning");
    expect(description?.message).toContain("description of 1,100 characters, over the 1,024-character limit");

    const [listing] = limitDiagnostics(plan.diagnostics, "codex-skill-listing-chars");
    expect(listing?.severity).toBe("warning");
    // 7 × 1,000 global + 1,024 (truncated) + 6 = 8,030.
    expect(listing?.message).toContain("the 9 skills listed at scope . are 8,030 characters, over the 8,000-character limit");
    expect(() => assertPlanValid(plan)).toThrow("codex-skill-name-chars");
  });
});

describe("Claude limits", () => {
  test("notes a CLAUDE.md over 200 lines, counting what it imports", async () => {
    const s = await setup(['harnesses = ["generic", "claude"]', ...scope(".")], {
      "project/.config/agentsmith/templates/guide/default.md": `# Guide\n\n${lines(250)}\n`,
    });
    const plan = await buildProjectPlan(s.project, s.machine);
    // CLAUDE.md is only `@AGENTS.md`; the imported AGENTS.md is what Claude loads.
    expect(new TextDecoder().decode(plan.writes.find((write) => write.destination === join(s.project, "CLAUDE.md"))!.content)).toBe("@AGENTS.md\n");
    const [found] = limitDiagnostics(plan.diagnostics, "claude-instruction-file-lines");
    expect(found?.severity).toBe("notice");
    expect(found?.message).toBe(
      `Claude Code: ${join(s.project, "CLAUDE.md")} is 253 lines including 1 imported file, over the recommended 200-line limit for a CLAUDE.md or CLAUDE.local.md file; Claude Code still loads all of it, but long files use more context and are followed less reliably (budgets.claude.instruction_file_lines)`,
    );
    expect(() => assertPlanValid(plan, true)).not.toThrow();
  });

  test("warns when a nested CLAUDE.md loaded on demand passes 40,000 characters, but not at the root", async () => {
    const s = await setup(['harnesses = ["claude"]', ...scope("."), ...scope("app")], {
      "project/.config/agentsmith/templates/guide/default.md": `# Guide\n\n${"z".repeat(41_000)}\n`,
      "project/app/README.md": "app\n",
    });
    const plan = await buildProjectPlan(s.project, s.machine);
    const found = limitDiagnostics(plan.diagnostics, "claude-on-demand-file-chars");
    expect(found.map((item) => item.path)).toEqual([join(s.project, "app", "CLAUDE.md")]);
    expect(found[0]!.message).toContain("41,010 characters, over the 40,000-character limit");
    expect(found[0]!.message).toContain("reads only the start of it");
  });

  test("rejects an @import chain deeper than four hops", async () => {
    const s = await setup(['harnesses = ["claude"]', ...scope(".")], {
      "project/.config/agentsmith/templates/guide/default.md": "# Guide\n\n@docs/a.md\n",
      "project/docs/a.md": "@b.md\n",
      "project/docs/b.md": "@c.md\n",
      "project/docs/c.md": "@d.md\n",
      "project/docs/d.md": "@e.md\n",
      "project/docs/e.md": "Deep.\n",
    });
    const plan = await buildProjectPlan(s.project, s.machine);
    const [found] = limitDiagnostics(plan.diagnostics, "claude-import-depth");
    expect(found?.severity).toBe("error");
    expect(found?.message).toContain("is 5 hops deep (CLAUDE.md -> a.md -> b.md -> c.md -> d.md -> e.md), over the 4-hop limit");
    expect(found?.message).toContain(`so ${join(s.project, "docs", "e.md")} is not loaded`);

    await put(join(s.project, "docs", "d.md"), "Shallow enough.\n");
    expect(limitDiagnostics((await buildProjectPlan(s.project, s.machine)).diagnostics, "claude-import-depth")).toEqual([]);
  });

  test("checks skill descriptions with when_to_use, SKILL.md length, and the listing budget", async () => {
    const files: Record<string, string> = {
      "project/.config/agentsmith/templates/guide/default.md": "# Guide\n",
      "project/.config/agentsmith/skills/wordy/SKILL.md": skill("wordy", "w".repeat(1000), `when_to_use: ${"u".repeat(600)}\n`),
      "project/.config/agentsmith/skills/long/SKILL.md": skill("long", "Long.", "", lines(520)),
    };
    for (let index = 0; index < 5; index++) files[`home/.claude/skills/g${index}/SKILL.md`] = skill(`g${index}`, "d".repeat(1400));
    const s = await setup(['harnesses = ["claude"]', ...scope("."), 'skills_enable = ["wordy", "long"]'], files);
    const plan = await buildProjectPlan(s.project, s.machine);

    const [description] = limitDiagnostics(plan.diagnostics, "claude-skill-description-chars");
    expect(description?.message).toContain("description + when_to_use of 1,601 characters, over the 1,536-character limit; Claude Code truncates the text");
    const [file] = limitDiagnostics(plan.diagnostics, "claude-skill-file-lines");
    expect(file?.severity).toBe("notice");
    expect(file?.message).toContain("is 525 lines, over the recommended 500-line limit for a SKILL.md");
    const [listing] = limitDiagnostics(plan.diagnostics, "claude-skill-listing-tokens");
    expect(listing?.severity).toBe("warning");
    expect(listing?.message).toMatch(
      /the 7 skills listed at scope \. are about [\d,]+ tokens \(estimated at 4 characters per token\), over the 2,000-token \(estimated\) limit/,
    );
  });

  test("checks the global CLAUDE.md and global skills", async () => {
    const s = await setup([]);
    await put(join(s.source, "profiles", "unused.toml"), 'harnesses = ["claude"]\ntemplate = "guide"\nskills_enable = ["long"]\n');
    await put(join(s.source, "templates", "guide", "default.md"), `# Guide\n\n${lines(210)}\n`);
    await put(join(s.source, "skills", "long", "SKILL.md"), skill("long", "Long.", "", lines(510)));
    const plan = await buildGlobalPlan(s.machine);
    expect(limitDiagnostics(plan.diagnostics, "claude-instruction-file-lines").map((item) => item.path)).toEqual([join(s.home, ".claude", "CLAUDE.md")]);
    expect(limitDiagnostics(plan.diagnostics, "claude-skill-file-lines").map((item) => item.path)).toEqual([
      join(s.home, ".claude", "skills", "long", "SKILL.md"),
    ]);
    expect(limitDiagnostics(plan.diagnostics, "claude-on-demand-file-chars")).toEqual([]);
  });
});

describe("limits on the command line", () => {
  test("lint reports limits, warnings fail only with --warnings-as-errors, and notices never fail", async () => {
    const f = await projectFixture("agentsmith-limits-cli-");
    await put(
      join(f.config, "config.toml"),
      ['harnesses = ["generic", "codex", "claude"]', ...scope("."), ...scope("app"), "[budgets.codex]", "project_doc_bytes = 1000", ""].join("\n"),
    );
    await put(join(f.config, "templates", "guide", "default.md"), `# Guide\n\n${lines(210)}\n`);
    await put(join(f.project, "app", "README.md"), "app\n");
    await commitAll(f, "fixture");

    const lint = await f.asmith("project", "lint");
    expect(lint.exitCode, lint.stderr).toBe(0);
    expect(lint.stderr).toContain("NOTICE claude-instruction-file-lines: Claude Code:");
    expect(lint.stderr).toContain("WARNING codex-project-doc-bytes: Codex: the instruction files loaded at scope app (");
    expect(lint.stderr).toContain("over the 1,000-byte limit");
    expect((await f.asmith("project", "lint", "--warnings-as-errors")).exitCode).not.toBe(0);

    await put(join(f.config, "config.toml"), ['harnesses = ["generic", "codex", "claude"]', ...scope("."), ...scope("app"), ""].join("\n"));
    const relaxed = await f.asmith("project", "lint", "--warnings-as-errors");
    expect(relaxed.exitCode, relaxed.stderr).toBe(0);
    expect(relaxed.stderr).toContain("NOTICE claude-instruction-file-lines");

    const generate = await f.asmith("project", "generate");
    expect(generate.exitCode, generate.stderr).toBe(0);
    expect(generate.stderr).toContain("NOTICE claude-instruction-file-lines");
  });

  test("global generate prints limit notices without recording them as run warnings", async () => {
    const s = await setup([]);
    await put(join(s.source, "profiles", "unused.toml"), 'harnesses = ["claude"]\ntemplate = "guide"\n');
    await put(join(s.source, "templates", "guide", "default.md"), `# Guide\n\n${lines(210)}\n`);
    const result = await run(["bun", cli, "global", "generate", "--config", s.machine], s.root, { ...Bun.env, HOME: s.root, CODEX_HOME: undefined });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("NOTICE claude-instruction-file-lines");
    const status = JSON.parse(await readFile(join(s.home, ".agents", "agentsmith", "status.json"), "utf8"));
    expect(JSON.stringify(status.warnings ?? [])).not.toContain("claude-instruction-file-lines");
  });

  test("a config error names an unknown harness in [budgets]", async () => {
    const f = await projectFixture("agentsmith-limits-cli-");
    await put(join(f.config, "config.toml"), ['harnesses = ["codex"]', ...scope("."), "[budgets.nope]", "x = 1", ""].join("\n"));
    await put(join(f.config, "templates", "guide", "default.md"), "# Guide\n");
    const lint = await f.asmith("project", "lint");
    expect(lint.exitCode).not.toBe(0);
    expect(lint.stderr).toContain('budgets contains unknown harness "nope"');
  });
});

describe("Antigravity limits", () => {
  test("rejects a rule file over 24,000 bytes and warns when always-on rules pass 20,000 tokens", async () => {
    const rule = (size: number) => `---\ntrigger: always_on\n---\n${"y".repeat(size)}\n`;
    const s = await setup(['harnesses = ["antigravity"]', ...scope(".")], {
      "project/.config/agentsmith/templates/guide/default.md": `# Guide\n\n${"x".repeat(25_000)}\n`,
      "project/.agents/rules/a.md": rule(23_000),
      "project/.agents/rules/b.md": rule(23_000),
      "project/.agents/rules/c.md": rule(23_000),
      "project/.agents/rules/manual.md": `---\ntrigger: manual\n---\n${"z".repeat(30_000)}\n`,
      "home/.gemini/config/rules/global.md": rule(100),
    });
    const plan = await buildProjectPlan(s.project, s.machine);
    const files = limitDiagnostics(plan.diagnostics, "antigravity-rule-file-bytes");
    expect(files.map((item) => item.severity)).toEqual(["error"]);
    expect(files[0]!.message).toContain(join(s.project, "AGENTS.md"));
    expect(files[0]!.message).toContain("Antigravity truncates the file at the limit");
    const chain = limitDiagnostics(plan.diagnostics, "antigravity-always-on-tokens");
    expect(chain).toHaveLength(1);
    expect(chain[0]!.severity).toBe("warning");
    expect(chain[0]!.message).toContain(join(s.home, ".gemini", "config", "rules", "global.md"));
    expect(chain[0]!.message).not.toContain("manual.md");
    expect(chain[0]!.message).toContain("estimated");
  });
});
