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
  await put(join(source, "profiles", "test.toml"), ['harnesses = ["codex", "claude-code"]', 'template = "base"', 'packs = ["base"]', ""].join("\n"));
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
    ['harnesses = ["codex", "claude-code"]', "", "[[scopes]]", 'path = "."', 'template = "base"', 'packs = ["base"]', ""].join("\n"),
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

  test("plans project instructions and composed skills in native roots", async () => {
    const setup = await fixture();
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(plan.writes.some((write) => write.destination === join(setup.project, "AGENTS.md"))).toBeTrue();
    expect(plan.writes.some((write) => write.destination === join(setup.project, "CLAUDE.md"))).toBeTrue();
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
    const instructions = new TextDecoder().decode(plan.writes.find((write) => write.destination === join(setup.project, "AGENTS.md"))!.content);
    expect(instructions).toContain("# Project Instructions");
    expect(instructions).toContain("Project evidence.");
    expect(instructions).not.toContain("Source evidence.");
    expect(instructions.indexOf("Be kind.")).toBeLessThan(instructions.indexOf("Be project-aware."));

    const skill = new TextDecoder().decode(
      plan.writes.find((write) => write.destination === join(setup.project, ".agents", "skills", setup.skill, "SKILL.md"))!.content,
    );
    expect(skill).toContain("# Project Review");
    expect(skill.indexOf("Check the work carefully.")).toBeLessThan(skill.indexOf("Check project policy."));
    expect(plan.writes.filter((write) => write.destination.endsWith(`/${setup.skill}/SKILL.md`))).toHaveLength(2);
    expect(plan.writes.filter((write) => write.destination.endsWith(`/${projectSkill}/SKILL.md`))).toHaveLength(2);

    const explanation = plan.explanation as { artifacts: Array<Record<string, unknown>> };
    const instruction = explanation.artifacts.find((artifact) => artifact.kind === "instruction" && artifact.harness === "codex")!;
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
    const instructions = new TextDecoder().decode(plan.writes.find((write) => write.destination === join(setup.project, "AGENTS.md"))!.content);
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
    let instructions = writeText(plan, join(setup.project, "AGENTS.md"));
    expect(instructions).toContain("Source evidence.");

    await put(projectPartial, "Project evidence.\n");
    plan = await buildProjectPlan(setup.project, setup.machine);
    instructions = writeText(plan, join(setup.project, "AGENTS.md"));
    expect(instructions).toContain("Project evidence.");

    await put(template, "# Local\n\n<!-- agentsmith:include source:evidence.md -->\n");
    plan = await buildProjectPlan(setup.project, setup.machine);
    instructions = writeText(plan, join(setup.project, "AGENTS.md"));
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
      ['harnesses = ["codex"]', "", "[[scopes]]", 'path = "."', 'packs = ["acme-tracker"]', ""].join("\n"),
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
});
