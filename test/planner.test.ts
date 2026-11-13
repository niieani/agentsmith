import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGlobalPlan, buildProjectPlan } from "../src/planner.ts";

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function writeText(plan: { writes: Array<{ destination: string; content: Uint8Array }> }, destination: string): string {
  const write = plan.writes.find((candidate) => candidate.destination === destination);
  if (!write) throw new Error(`missing planned write ${destination}`);
  return new TextDecoder().decode(write.content);
}

async function fixture(): Promise<{ root: string; source: string; machine: string; project: string; skill: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-planner-"));
  const source = join(root, "source");
  const project = join(root, "project");
  const skill = "agentsmith-fixture-review";
  await mkdir(project, { recursive: true });
  await put(join(source, "agentsmith.toml"), "");
  await put(join(source, "profiles", "test.toml"), ['harnesses = ["generic", "codex", "claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
  await put(join(source, "templates", "base", "default.md"), "# Instructions\n\n## Greeting\n\n<!-- agentsmith:required-slot greeting -->\n");
  await put(join(source, "packs", "base", "pack.toml"), `skills = ["${skill}"]\n`);
  await put(join(source, "packs", "base", "instructions", "greeting", "10-hello.md"), "Be kind.\n");
  await put(join(source, "packs", "base", "skill-slots", "detail", "10-detail.md"), "Check the work carefully.\n");
  await put(
    join(source, "skills", skill, "SKILL.md"),
    `---\nname: ${skill}\ndescription: Review a fixture.\n---\n\n# Review\n\n<!-- agentsmith:required-slot detail -->\n`,
  );
  const machine = join(root, "machine.toml");
  await put(machine, `source = ${JSON.stringify(source)}\nprofile = "test"\n`);
  await put(
    join(project, ".config", "agentsmith", "config.toml"),
    ['harnesses = ["generic", "codex", "claude"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
  );
  return { root, source, machine, project, skill };
}

describe("generation planning", () => {
  test("plans both harnesses from one global profile", async () => {
    const setup = await fixture();
    const plan = await buildGlobalPlan(setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(plan.writes.some((write) => write.destination.endsWith("/.codex/AGENTS.md"))).toBeTrue();
    expect(plan.writes.some((write) => write.destination.endsWith("/.claude/CLAUDE.md"))).toBeTrue();
    expect(plan.writes.filter((write) => write.destination.endsWith("SKILL.md"))).toHaveLength(2);
    expect(new TextDecoder().decode(plan.writes.find((write) => write.destination.endsWith("AGENTS.md"))!.content)).toContain("Be kind.");
  });

  test("plans global artifacts from an extended profile and explains the chain", async () => {
    const setup = await fixture();
    await put(join(setup.source, "profiles", "test.toml"), ['harnesses = ["codex", "claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
    await put(join(setup.source, "profiles", "laptop.toml"), ['extends = "test"', 'harnesses = ["generic", "codex"]', 'packs = ["travel"]', ""].join("\n"));
    await put(join(setup.source, "packs", "travel", "instructions", "greeting", "20-travel.md"), "Mind the battery.\n");
    await put(setup.machine, `source = ${JSON.stringify(setup.source)}\nprofile = "laptop"\n`);
    const plan = await buildGlobalPlan(setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(plan.writes.some((write) => write.destination.endsWith("/.claude/CLAUDE.md"))).toBeFalse();
    const agents = new TextDecoder().decode(plan.writes.find((write) => write.destination.endsWith("/.codex/AGENTS.md"))!.content);
    expect(agents.indexOf("Be kind.")).toBeGreaterThanOrEqual(0);
    expect(agents.indexOf("Mind the battery.")).toBeGreaterThan(agents.indexOf("Be kind."));
    expect((plan.explanation as { profile: unknown }).profile).toEqual({
      name: "laptop",
      chain: ["test", "laptop"],
      packs: [
        { pack: "base", profile: "test" },
        { pack: "travel", profile: "laptop" },
      ],
    });
  });

  test("plans project instructions and composed skills in native roots", async () => {
    const setup = await fixture();
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    // Every instruction input is personal (Source Repository), so only personal files carry them.
    expect(plan.writes.some((write) => write.destination === join(setup.project, "AGENTS.md"))).toBeFalse();
    expect(plan.writes.some((write) => write.destination === join(setup.project, "CLAUDE.md"))).toBeFalse();
    expect(writeText(plan, join(setup.project, "AGENTS.override.md"))).toContain("Be kind.");
    expect(writeText(plan, join(setup.project, "CLAUDE.local.md"))).toBe("@AGENTS.override.md\n");
    expect(plan.claudeMdExcludes).toEqual([]);
    const skill = plan.writes.find((write) => write.destination === join(setup.project, ".agents", "skills", setup.skill, "SKILL.md"));
    expect(skill).toBeDefined();
    expect(new TextDecoder().decode(skill!.content)).toContain("Check the work carefully.");
  });

  test("prefers project singular sources and composes matching packs source then project", async () => {
    const setup = await fixture();
    const projectSkill = "agentsmith-project-review";
    await put(
      join(setup.project, ".config", "agentsmith", "templates", "base", "default.md"),
      "# Project Instructions\n\n<!-- agentsmith:include evidence.md -->\n\n## Greeting\n\n<!-- agentsmith:required-slot greeting -->\n",
    );
    await put(join(setup.source, "partials", "evidence.md"), "Source evidence.\n");
    await put(join(setup.project, ".config", "agentsmith", "partials", "evidence.md"), "Project evidence.\n");
    await put(join(setup.project, ".config", "agentsmith", "packs", "base", "instructions", "greeting", "20-project.md"), "Be project-aware.\n");
    await put(join(setup.project, ".config", "agentsmith", "packs", "base", "skill-slots", "detail", "20-project.md"), "Check project policy.\n");
    await put(join(setup.project, ".config", "agentsmith", "packs", "base", "pack.toml"), `skills = ["${setup.skill}", "${projectSkill}"]\n`);
    await put(
      join(setup.project, ".config", "agentsmith", "skills", setup.skill, "SKILL.md"),
      `---\nname: ${setup.skill}\ndescription: Project review.\n---\n\n# Project Review\n\n<!-- agentsmith:required-slot detail -->\n`,
    );
    await put(
      join(setup.project, ".config", "agentsmith", "skills", projectSkill, "SKILL.md"),
      `---\nname: ${projectSkill}\ndescription: Project-only review.\n---\n\n# Project-only Review\n\n<!-- agentsmith:required-slot detail -->\n`,
    );

    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const instructions = writeText(plan, join(setup.project, "AGENTS.override.md"));
    expect(instructions).toContain("# Project Instructions");
    expect(instructions).toContain("Project evidence.");
    expect(instructions).not.toContain("Source evidence.");
    expect(instructions.indexOf("Be kind.")).toBeLessThan(instructions.indexOf("Be project-aware."));
    // The shared layer leaves out the Source Repository pack.
    const shared = writeText(plan, join(setup.project, "AGENTS.md"));
    expect(shared).toContain("Be project-aware.");
    expect(shared).not.toContain("Be kind.");

    const skill = new TextDecoder().decode(
      plan.writes.find((write) => write.destination === join(setup.project, ".agents", "skills", setup.skill, "SKILL.md"))!.content,
    );
    expect(skill).toContain("# Project Review");
    expect(skill.indexOf("Check the work carefully.")).toBeLessThan(skill.indexOf("Check project policy."));
    expect(plan.writes.filter((write) => write.destination.endsWith(`/${setup.skill}/SKILL.md`))).toHaveLength(2);
    expect(plan.writes.filter((write) => write.destination.endsWith(`/${projectSkill}/SKILL.md`))).toHaveLength(2);

    const explanation = plan.explanation as { artifacts: Array<Record<string, unknown>> };
    const instruction = explanation.artifacts.find(
      (artifact) => artifact.kind === "instruction" && artifact.destination === join(setup.project, "AGENTS.override.md"),
    )!;
    expect(instruction.harnesses).toEqual(["codex"]);
    expect(instruction.layer).toBe("personal");
    expect(instruction).toMatchObject({ templateSelection: "base", templateSourceId: "project:base" });
    expect(instruction.packSources).toEqual([
      { selection: "base", sourceId: "source:base", directory: join(setup.source, "packs", "base") },
      { selection: "base", sourceId: "project:base", directory: join(setup.project, ".config", "agentsmith", "packs", "base") },
    ]);
  });

  test("ownership qualifiers constrain singular and pack resolution", async () => {
    const setup = await fixture();
    await put(join(setup.project, ".config", "agentsmith", "templates", "base", "default.md"), "# Project-only template\n");
    await put(join(setup.project, ".config", "agentsmith", "packs", "base", "instructions", "greeting", "10-project.md"), "Project-only greeting.\n");
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'template = "source:base"', 'packs = ["project:base"]', ""].join("\n"),
    );

    const plan = await buildProjectPlan(setup.project, setup.machine);
    const instructions = writeText(plan, join(setup.project, "AGENTS.override.md"));
    expect(instructions).toContain("# Instructions");
    expect(instructions).toContain("Project-only greeting.");
    expect(instructions).not.toContain("Be kind.");
  });

  test("resolves partials project-first with Source Repository fallback and qualifiers", async () => {
    const setup = await fixture();
    const template = join(setup.project, ".config", "agentsmith", "templates", "local", "default.md");
    const projectPartial = join(setup.project, ".config", "agentsmith", "partials", "evidence.md");
    await put(template, "# Local\n\n<!-- agentsmith:include evidence.md -->\n");
    await put(join(setup.source, "partials", "evidence.md"), "Source evidence.\n");
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'template = "local"', "packs = []", ""].join("\n"),
    );

    let plan = await buildProjectPlan(setup.project, setup.machine);
    let instructions = writeText(plan, join(setup.project, "AGENTS.override.md"));
    expect(instructions).toContain("Source evidence.");
    // A Source Repository partial is personal: the shared layer leaves the include out.
    expect(writeText(plan, join(setup.project, "AGENTS.md"))).toBe("# Local\n");

    await put(projectPartial, "Project evidence.\n");
    plan = await buildProjectPlan(setup.project, setup.machine);
    instructions = writeText(plan, join(setup.project, "AGENTS.md"));
    expect(instructions).toContain("Project evidence.");
    expect(plan.writes.some((write) => write.destination === join(setup.project, "AGENTS.override.md"))).toBeFalse();

    await put(template, "# Local\n\n<!-- agentsmith:include source:evidence.md -->\n");
    plan = await buildProjectPlan(setup.project, setup.machine);
    instructions = writeText(plan, join(setup.project, "AGENTS.override.md"));
    expect(instructions).toContain("Source evidence.");
  });

  test("rejects missing qualified sources and duplicate resolved pack selections", async () => {
    const setup = await fixture();
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'template = "project:missing"', "packs = []", ""].join("\n"),
    );
    await expect(buildProjectPlan(setup.project, setup.machine)).rejects.toThrow(/missing template source.*project:missing/);

    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base", "source:base"]', ""].join("\n"),
    );
    await expect(buildProjectPlan(setup.project, setup.machine)).rejects.toThrow(/duplicate resolved pack source.*source:base/);
  });

  test("rejects missing qualified and unqualified skill exclusions", async () => {
    const setup = await fixture();
    for (const exclusion of ["project:missing", "missing"]) {
      await put(
        join(setup.project, ".config", "agentsmith", "config.toml"),
        ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', "packs = []", `skills_disable = [${JSON.stringify(exclusion)}]`, ""].join("\n"),
      );
      await expect(buildProjectPlan(setup.project, setup.machine)).rejects.toThrow(/missing skill source.*missing/);
    }
  });

  test("rejects ownership aliases that repeat an inherited resolved pack", async () => {
    const setup = await fixture();
    await mkdir(join(setup.project, "child"), { recursive: true });
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'packs = ["base"]', "", "[[scopes]]", 'path = "child"', 'packs = ["source:base"]', ""].join(
        "\n",
      ),
    );
    await expect(buildProjectPlan(setup.project, setup.machine)).rejects.toThrow(/repeats inherited pack source source:base/);
  });

  test("reuses a project-owned skill-slot contribution across shared skills", async () => {
    const setup = await fixture();
    const secondSkill = "agentsmith-fixture-summarize";
    await put(
      join(setup.source, "skills", secondSkill, "SKILL.md"),
      `---\nname: ${secondSkill}\ndescription: Summarize a fixture.\n---\n\n# Summarize\n\n<!-- agentsmith:required-slot detail -->\n`,
    );
    await put(join(setup.project, ".config", "agentsmith", "packs", "acme-tracker", "pack.toml"), `skills = ["${setup.skill}", "${secondSkill}"]\n`);
    await put(
      join(setup.project, ".config", "agentsmith", "packs", "acme-tracker", "skill-slots", "detail", "10-acme.md"),
      "Use the project's Acme tracker.\n",
    );
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["generic"]', "", "[[scopes]]", 'path = "."', 'packs = ["acme-tracker"]', ""].join("\n"),
    );

    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(plan.diagnostics.some((item) => item.code === "skill-contribution-inactive")).toBeFalse();
    for (const name of [setup.skill, secondSkill]) {
      const skill = plan.writes.find((write) => write.destination === join(setup.project, ".agents", "skills", name, "SKILL.md"));
      expect(skill).toBeDefined();
      expect(new TextDecoder().decode(skill!.content)).toContain("Use the project's Acme tracker.");
    }
  });

  test("warns when no enabled skill consumes a selected skill slot", async () => {
    const setup = await fixture();
    await put(join(setup.source, "packs", "base", "skill-slots", "unused", "10-unused.md"), "Unused.\n");

    const plan = await buildGlobalPlan(setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "skill-contribution-inactive" && item.path?.endsWith("10-unused.md"))).toBeTrue();
  });

  test("rejects skill-name-coupled pack contribution directories", async () => {
    const setup = await fixture();
    await put(join(setup.source, "packs", "base", "skills", setup.skill, "detail", "10-coupled.md"), "Coupled.\n");

    const plan = await buildGlobalPlan(setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "skill-contribution-layout" && item.severity === "error")).toBeTrue();
  });

  test("applies claude-specific template and contributions", async () => {
    const setup = await fixture();
    await put(join(setup.source, "templates", "base", "claude.md"), "# Claude\n\n<!-- agentsmith:required-slot greeting -->\n");
    await put(join(setup.source, "packs", "base", "instructions", "claude", "greeting", "20-claude.md"), "Claude only.\n");
    const plan = await buildGlobalPlan(setup.machine);
    const claude = plan.writes.find((write) => write.destination.endsWith("/.claude/CLAUDE.md"))!;
    const codex = plan.writes.find((write) => write.destination.endsWith("/.codex/AGENTS.md"))!;
    expect(new TextDecoder().decode(claude.content)).toContain("Claude only.");
    expect(new TextDecoder().decode(codex.content)).not.toContain("Claude only.");
  });

  test("rejects sources that still use the removed claude-code harness name", async () => {
    for (const legacy of [
      ["templates", "base", "claude-code.md"],
      ["packs", "base", "instructions", "claude-code", "greeting", "20-legacy.md"],
      ["packs", "base", "skill-slots", "harnesses", "claude-code", "detail", "20-legacy.md"],
    ]) {
      const setup = await fixture();
      await put(join(setup.source, ...legacy), "Legacy.\n");
      await expect(buildGlobalPlan(setup.machine)).rejects.toThrow(/removed harness name "claude-code"/);
    }
  });

  test("detects an unmanaged skill in an intermediate ancestor root", async () => {
    const setup = await fixture();
    await mkdir(join(setup.project, "services", "api"), { recursive: true });
    await put(
      join(setup.project, "services", ".agents", "skills", setup.skill, "SKILL.md"),
      `---\nname: ${setup.skill}\ndescription: Unmanaged ancestor.\n---\n`,
    );
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', "packs = []", "", "[[scopes]]", 'path = "services/api"', 'packs = ["base"]', ""].join("\n"),
    );
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "planned-unmanaged-skill-collision" && item.severity === "error")).toBeTrue();
  });

  test("detects an unmanaged duplicate in an undeclared descendant scope", async () => {
    const setup = await fixture();
    await put(
      join(setup.project, "packages", "hidden", ".agents", "skills", setup.skill, "SKILL.md"),
      `---\nname: ${setup.skill}\ndescription: Descendant duplicate.\n---\n`,
    );
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'packs = ["base"]', ""].join("\n"),
    );
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "planned-unmanaged-skill-collision" && item.path?.includes("packages/hidden"))).toBeTrue();
  });

  test("CLAUDE.md imports an identical sibling AGENTS.md by default", async () => {
    const setup = await fixture();
    await put(join(setup.project, ".config", "agentsmith", "templates", "shared", "default.md"), "# Shared\n");
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["generic", "codex", "claude"]', "", "[[scopes]]", 'path = "."', 'template = "shared"', "packs = []", ""].join("\n"),
    );
    let plan = await buildProjectPlan(setup.project, setup.machine);
    expect(writeText(plan, join(setup.project, "CLAUDE.md"))).toBe("@AGENTS.md\n");
    expect(writeText(plan, join(setup.project, "AGENTS.md"))).toBe("# Shared\n");
    let explanation = plan.explanation as { artifacts: Array<Record<string, unknown>> };
    expect(explanation.artifacts.find((artifact) => artifact.destination === join(setup.project, "CLAUDE.md"))).toMatchObject({
      importsFrom: join(setup.project, "AGENTS.md"),
      layer: "shared",
    });

    // Identical personal files import each other the same way.
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex", "claude"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
    );
    plan = await buildProjectPlan(setup.project, setup.machine);
    expect(writeText(plan, join(setup.project, "CLAUDE.local.md"))).toBe("@AGENTS.override.md\n");
    expect(writeText(plan, join(setup.project, "AGENTS.override.md"))).toContain("Be kind.");
    explanation = plan.explanation as { artifacts: Array<Record<string, unknown>> };
    expect(explanation.artifacts.find((artifact) => artifact.destination === join(setup.project, "CLAUDE.local.md"))).toMatchObject({
      importsFrom: join(setup.project, "AGENTS.override.md"),
      layer: "personal",
    });
  });

  test("CLAUDE.md stays flat when it differs from AGENTS.md or the project opts out", async () => {
    const setup = await fixture();
    await put(join(setup.source, "packs", "base", "instructions", "claude", "greeting", "20-claude.md"), "Claude only.\n");
    let plan = await buildProjectPlan(setup.project, setup.machine);
    expect(writeText(plan, join(setup.project, "CLAUDE.local.md"))).toContain("Claude only.");

    const optOut = await fixture();
    await put(
      join(optOut.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex", "claude"]', "claude_import_agents_md = false", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join(
        "\n",
      ),
    );
    plan = await buildProjectPlan(optOut.project, optOut.machine);
    expect(writeText(plan, join(optOut.project, "CLAUDE.local.md"))).toBe(writeText(plan, join(optOut.project, "AGENTS.override.md")));
    expect(writeText(plan, join(optOut.project, "CLAUDE.local.md"))).toContain("Be kind.");
  });

  test("renders one shared AGENTS.md with Codex variants only when Codex is selected", async () => {
    const setup = await fixture();
    const own = join(setup.project, ".config", "agentsmith");
    await put(join(own, "templates", "base", "codex.md"), "# Codex\n\n<!-- agentsmith:required-slot greeting -->\n");
    await put(join(own, "templates", "base", "generic.md"), "# Generic\n\n<!-- agentsmith:required-slot greeting -->\n");
    await put(join(own, "packs", "proj", "instructions", "greeting", "10-hello.md"), "Be kind.\n");
    await put(join(own, "packs", "proj", "instructions", "codex", "greeting", "20-codex.md"), "Codex only.\n");
    await put(join(own, "packs", "proj", "instructions", "generic", "greeting", "20-generic.md"), "Generic only.\n");
    const config = (harnesses: string) =>
      put(
        join(setup.project, ".config", "agentsmith", "config.toml"),
        [`harnesses = ${harnesses}`, "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["proj"]', ""].join("\n"),
      );

    await config('["generic", "codex"]');
    let plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(plan.writes.filter((write) => write.kind === "instruction")).toHaveLength(1);
    let agents = writeText(plan, join(setup.project, "AGENTS.md"));
    expect(agents).toStartWith("# Codex");
    expect(agents.indexOf("Be kind.")).toBeLessThan(agents.indexOf("Generic only."));
    expect(agents.indexOf("Generic only.")).toBeLessThan(agents.indexOf("Codex only."));

    await config('["generic"]');
    plan = await buildProjectPlan(setup.project, setup.machine);
    agents = writeText(plan, join(setup.project, "AGENTS.md"));
    expect(agents).toStartWith("# Generic");
    expect(agents).not.toContain("Codex only.");
  });

  test("places skills per harness: shared .agents root, Codex-only .codex root, Claude root", async () => {
    const setup = await fixture();
    const agents = join(setup.project, ".agents", "skills", setup.skill, "SKILL.md");
    const codex = join(setup.project, ".codex", "skills", setup.skill, "SKILL.md");
    const claude = join(setup.project, ".claude", "skills", setup.skill, "SKILL.md");
    const has = (plan: { writes: Array<{ destination: string }> }, path: string) => plan.writes.some((write) => write.destination === path);
    const config = (lines: string[]) =>
      put(
        join(setup.project, ".config", "agentsmith", "config.toml"),
        [...lines.slice(0, 1), "[[scopes]]", 'path = "."', 'packs = ["base"]', ...lines.slice(1), ""].join("\n"),
      );

    let plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect([has(plan, agents), has(plan, codex), has(plan, claude)]).toEqual([true, false, true]);

    await config(['harnesses = ["codex", "claude"]']);
    plan = await buildProjectPlan(setup.project, setup.machine);
    expect([has(plan, agents), has(plan, codex), has(plan, claude)]).toEqual([false, true, true]);

    await put(join(setup.source, "packs", "base", "skill-slots", "harnesses", "codex", "detail", "20-codex.md"), "Codex detail.\n");
    await config(['harnesses = ["generic", "codex"]', "[scopes.harness_skills.generic]", `disable = ["${setup.skill}"]`]);
    plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect([has(plan, agents), has(plan, codex)]).toEqual([false, true]);
    expect(writeText(plan, codex)).toContain("Codex detail.");
  });

  test("rejects harness-specific skill content in a root shared with another harness", async () => {
    const setup = await fixture();
    await put(join(setup.source, "packs", "base", "skill-slots", "harnesses", "codex", "detail", "20-codex.md"), "Codex detail.\n");
    await put(join(setup.source, "packs", "base", "skill-slots", "harnesses", "claude", "detail", "20-claude.md"), "Claude detail.\n");
    const plan = await buildProjectPlan(setup.project, setup.machine);
    const shared = plan.diagnostics.filter((item) => item.code === "skill-harness-content-shared-root");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ severity: "error" });
    expect(shared[0]!.path).toEndWith("20-codex.md");
    expect(writeText(plan, join(setup.project, ".agents", "skills", setup.skill, "SKILL.md"))).not.toContain("Codex detail.");
    expect(writeText(plan, join(setup.project, ".claude", "skills", setup.skill, "SKILL.md"))).toContain("Claude detail.");
    expect(plan.diagnostics.some((item) => item.code === "skill-contribution-inactive")).toBeFalse();
  });

  test("rejects a global Codex skill that is not also enabled for generic", async () => {
    const setup = await fixture();
    await put(join(setup.source, "profiles", "test.toml"), ['harnesses = ["codex", "claude"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
    const plan = await buildGlobalPlan(setup.machine);
    const unplaceable = plan.diagnostics.filter((item) => item.code === "skill-harness-unplaceable");
    expect(unplaceable).toHaveLength(1);
    expect(unplaceable[0]!.message).toContain("enable it for generic");
    expect(plan.writes.filter((write) => write.destination.endsWith("SKILL.md")).map((write) => write.destination)).toEqual([
      expect.stringMatching(/\/\.claude\/skills\//),
    ]);
  });

  test("global generic emits skills but no instruction file", async () => {
    const setup = await fixture();
    await put(join(setup.source, "profiles", "test.toml"), ['harnesses = ["generic"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
    const plan = await buildGlobalPlan(setup.machine);
    expect(plan.writes.filter((write) => write.kind === "instruction")).toEqual([]);
    expect(plan.writes.some((write) => write.destination.endsWith(`/.agents/skills/${setup.skill}/SKILL.md`))).toBeTrue();
    expect(plan.diagnostics.some((item) => item.code === "instruction-layer-unsupported")).toBeTrue();
  });

  test("enables and disables skills per harness in profiles", async () => {
    const setup = await fixture();
    const extra = "agentsmith-fixture-deploy";
    await put(join(setup.source, "skills", extra, "SKILL.md"), `---\nname: ${extra}\ndescription: Deploy a fixture.\n---\n\nDeploy.\n`);
    await put(
      join(setup.source, "profiles", "test.toml"),
      [
        'harnesses = ["generic", "codex", "claude"]',
        'template = "base"',
        'packs = ["base"]',
        "[harness_skills.claude]",
        `enable = ["${extra}"]`,
        `disable = ["${setup.skill}"]`,
        "",
      ].join("\n"),
    );
    const plan = await buildGlobalPlan(setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const skills = plan.writes.filter((write) => write.destination.endsWith("SKILL.md")).map((write) => write.destination);
    expect(skills.filter((path) => path.includes("/.claude/skills/"))).toEqual([expect.stringContaining(`/${extra}/`)]);
    expect(skills.filter((path) => path.includes("/.agents/skills/"))).toEqual([expect.stringContaining(`/${setup.skill}/`)]);
  });

  test("warns about an inactive per-harness exclusion", async () => {
    const setup = await fixture();
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["codex", "claude"]', "[[scopes]]", 'path = "."', "packs = []", "[scopes.harness_skills.claude]", `disable = ["${setup.skill}"]`, ""].join(
        "\n",
      ),
    );
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "skill-exclusion-inactive" && item.message.includes("for claude"))).toBeTrue();
  });

  test("an unmanaged .codex skill collides with a planned .agents skill only when Codex is selected", async () => {
    const setup = await fixture();
    await put(join(setup.project, ".codex", "skills", setup.skill, "SKILL.md"), `---\nname: ${setup.skill}\ndescription: Unmanaged Codex.\n---\n`);
    let plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "planned-unmanaged-skill-collision" && item.path?.includes(".codex"))).toBeTrue();

    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      ['harnesses = ["generic"]', "[[scopes]]", 'path = "."', 'packs = ["base"]', ""].join("\n"),
    );
    plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "planned-unmanaged-skill-collision")).toBeFalse();
  });

  test("unmanaged skills in .agents and .codex roots are duplicates for Codex", async () => {
    const setup = await fixture();
    const name = "agentsmith-unmanaged-twin";
    for (const root of [".agents", ".codex"]) {
      await put(join(setup.project, root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Twin.\n---\n`);
    }
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "unmanaged-skill-collision" && item.message.includes(name))).toBeTrue();
  });

  test("a Codex-only skill and a generic skill of the same name on one chain collide for Codex", async () => {
    const setup = await fixture();
    await mkdir(join(setup.project, "sub"), { recursive: true });
    await put(
      join(setup.project, ".config", "agentsmith", "config.toml"),
      [
        'harnesses = ["generic", "codex"]',
        "[[scopes]]",
        'path = "."',
        "packs = []",
        "[scopes.harness_skills.codex]",
        `enable = ["${setup.skill}"]`,
        "[[scopes]]",
        'path = "sub"',
        "packs = []",
        'harnesses = ["generic"]',
        `skills_enable = ["${setup.skill}"]`,
        "",
      ].join("\n"),
    );
    const plan = await buildProjectPlan(setup.project, setup.machine);
    const collision = plan.diagnostics.find((item) => item.code === "skill-name-collision");
    expect(collision?.message).toContain("visible more than once for codex");
  });
});
