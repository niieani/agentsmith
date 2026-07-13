import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGlobalPlan, buildProjectPlan } from "../src/planner.ts";

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function fixture(): Promise<{ root: string; source: string; machine: string; project: string; skill: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentsmith-planner-"));
  const source = join(root, "source");
  const project = join(root, "project");
  const skill = "agentsmith-fixture-review";
  await mkdir(project, { recursive: true });
  await put(join(source, "agentsmith.toml"), "version = 1\n");
  await put(join(source, "profiles", "test.toml"), [
    "version = 1",
    'harnesses = ["codex", "claude-code"]',
    'template = "base"',
    'packs = ["base"]',
    "",
  ].join("\n"));
  await put(join(source, "templates", "base", "default.md"), "# Instructions\n\n## Greeting\n\n<!-- agentsmith:required-slot greeting -->\n");
  await put(join(source, "packs", "base", "pack.toml"), `version = 1\nskills = ["${skill}"]\n`);
  await put(join(source, "packs", "base", "instructions", "greeting", "10-hello.md"), "Be kind.\n");
  await put(join(source, "packs", "base", "skills", skill, "detail", "10-detail.md"), "Check the work carefully.\n");
  await put(join(source, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Review a fixture.\n---\n\n# Review\n\n<!-- agentsmith:required-slot detail -->\n`);
  const machine = join(root, "machine.toml");
  await put(machine, `version = 1\nsource = ${JSON.stringify(source)}\nprofile = "test"\n`);
  await put(join(project, ".config", "agentsmith", "config.toml"), [
    "version = 1",
    'harnesses = ["codex", "claude-code"]',
    "",
    "[[scopes]]",
    'path = "."',
    'template = "base"',
    'packs = ["base"]',
    "",
  ].join("\n"));
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

  test("detects an unmanaged skill in an intermediate ancestor root", async () => {
    const setup = await fixture();
    await mkdir(join(setup.project, "services", "api"), { recursive: true });
    await put(join(setup.project, "services", ".agents", "skills", setup.skill, "SKILL.md"), `---\nname: ${setup.skill}\ndescription: Unmanaged ancestor.\n---\n`);
    await put(join(setup.project, ".config", "agentsmith", "config.toml"), [
      "version = 1",
      'harnesses = ["codex"]',
      "",
      "[[scopes]]",
      'path = "."',
      'packs = []',
      "",
      "[[scopes]]",
      'path = "services/api"',
      'packs = ["base"]',
      "",
    ].join("\n"));
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "planned-unmanaged-skill-collision" && item.severity === "error")).toBeTrue();
  });

  test("detects an unmanaged duplicate in an undeclared descendant scope", async () => {
    const setup = await fixture();
    await put(join(setup.project, "packages", "hidden", ".agents", "skills", setup.skill, "SKILL.md"), `---\nname: ${setup.skill}\ndescription: Descendant duplicate.\n---\n`);
    await put(join(setup.project, ".config", "agentsmith", "config.toml"), [
      "version = 1",
      'harnesses = ["codex"]',
      "",
      "[[scopes]]",
      'path = "."',
      'packs = ["base"]',
      "",
    ].join("\n"));
    const plan = await buildProjectPlan(setup.project, setup.machine);
    expect(plan.diagnostics.some((item) => item.code === "planned-unmanaged-skill-collision" && item.path?.includes("packages/hidden"))).toBeTrue();
  });
});
