import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getHarnessAdapter,
  placeSkill,
  prioritySkillRoot,
  skillReadRoots,
  skillRootReaders,
  skillRootSuffixes,
  skillWriteRoot,
  type SkillLocation,
} from "../src/harness.ts";

const project = (scopePath = "."): SkillLocation => ({ mode: "project", projectRoot: "/repo", scopePath });
const global: SkillLocation = { mode: "global", home: "/home/me" };

describe("harness adapters", () => {
  test("maps generic destinations", () => {
    const adapter = getHarnessAdapter("generic");
    expect(adapter.globalInstruction("/home/me")).toBeUndefined();
    expect(adapter.globalSkillRoot("/home/me")).toBe("/home/me/.agents/skills");
    expect(adapter.projectInstruction("/repo", "apps/api")).toBe(join("/repo", "apps/api", "AGENTS.md"));
    expect(skillWriteRoot("generic", project("apps/api"))).toBe(join("/repo", "apps/api", ".agents", "skills"));
  });

  test("maps Codex destinations and read roots", () => {
    const adapter = getHarnessAdapter("codex");
    expect(adapter.globalInstruction("/home/me")).toBe("/home/me/.codex/AGENTS.md");
    expect(adapter.globalSkillRoot("/home/me")).toBeUndefined();
    expect(adapter.projectInstruction("/repo", "apps/api")).toBe(join("/repo", "apps/api", "AGENTS.md"));
    expect(skillWriteRoot("codex", project())).toBe(join("/repo", ".codex", "skills"));
    expect(skillReadRoots("codex", project())).toEqual([join("/repo", ".agents", "skills"), join("/repo", ".codex", "skills")]);
    expect(skillReadRoots("codex", global)).toEqual(["/home/me/.agents/skills", "/home/me/.codex/skills"]);
  });

  test("maps Claude destinations", () => {
    const adapter = getHarnessAdapter("claude");
    expect(adapter.globalInstruction("/home/me")).toBe("/home/me/.claude/CLAUDE.md");
    expect(skillWriteRoot("claude", project())).toBe(join("/repo", ".claude", "skills"));
    expect(adapter.instructionImport?.("AGENTS.md")).toBe("@AGENTS.md\n");
  });

  test("maps Antigravity destinations and read roots", () => {
    const adapter = getHarnessAdapter("antigravity");
    expect(adapter.globalInstruction("/home/me")).toBe("/home/me/.gemini/config/rules/agentsmith.md");
    expect(adapter.instructionFrontMatter).toBe("---\ntrigger: always_on\n---\n\n");
    expect(adapter.projectInstruction("/repo", "apps/api")).toBe(join("/repo", "apps/api", "AGENTS.md"));
    expect(adapter.projectPersonalRule?.("/repo", "apps/api")).toBe(join("/repo", "apps/api", ".agents", "rules", "agentsmith-personal.md"));
    expect(adapter.globalSkillRoot("/home/me")).toBe("/home/me/.gemini/config/skills");
    expect(skillWriteRoot("antigravity", project())).toBe(join("/repo", ".agents", "skills"));
    expect(skillReadRoots("antigravity", global)).toEqual(["/home/me/.gemini/config/skills", "/home/me/.gemini/skills"]);
    expect(skillReadRoots("antigravity", project())).toEqual([
      join("/repo", ".agents", "skills"),
      join("/repo", ".agent", "skills"),
      join("/repo", "_agents", "skills"),
      join("/repo", "_agent", "skills"),
    ]);
    expect(prioritySkillRoot("antigravity", project())).toBe(join("/repo", ".agent", "skills"));
    expect(prioritySkillRoot("antigravity", global)).toBeUndefined();
    expect(skillRootSuffixes()).toEqual([".agents/skills", ".codex/skills", ".claude/skills", ".agent/skills", ".gemini/config/skills"]);
  });

  test("computes root readers from adapter data", () => {
    expect(skillRootReaders(join("/repo", ".agents", "skills"), project())).toEqual(["generic", "codex", "antigravity"]);
    expect(skillRootReaders(join("/repo", ".codex", "skills"), project())).toEqual(["codex"]);
    expect(skillRootReaders("/home/me/.agents/skills", global)).toEqual(["generic", "codex"]);
    expect(skillRootReaders("/home/me/.claude/skills", global)).toEqual(["claude"]);
    expect(skillRootReaders("/home/me/.gemini/skills", global)).toEqual(["antigravity"]);
    expect(skillRootReaders(join("/repo", ".agent", "skills"), project())).toEqual(["antigravity"]);
  });
});

describe("skill placement", () => {
  test("a generic skill serves Codex through one shared root", () => {
    const result = placeSkill(["codex", "generic"], project());
    expect(result.unplaceable).toEqual([]);
    expect(result.placements).toEqual([
      { root: join("/repo", ".agents", "skills"), serves: ["generic", "codex"], readers: ["generic", "codex", "antigravity"], exclusiveReader: undefined },
    ]);
  });

  test("a Codex-only project skill lands in the root only Codex reads", () => {
    expect(placeSkill(["codex"], project("apps")).placements).toEqual([
      { root: join("/repo", "apps", ".codex", "skills"), serves: ["codex"], readers: ["codex"], exclusiveReader: "codex" },
    ]);
  });

  test("Claude gets its own exclusive root alongside the shared one", () => {
    const result = placeSkill(["generic", "codex", "claude"], project());
    expect(result.placements.map((item) => [item.root, item.exclusiveReader])).toEqual([
      [join("/repo", ".agents", "skills"), undefined],
      [join("/repo", ".claude", "skills"), "claude"],
    ]);
  });

  test("an Antigravity skill shares .agents/skills in a project and has its own global root", () => {
    expect(placeSkill(["generic", "antigravity"], project()).placements).toEqual([
      {
        root: join("/repo", ".agents", "skills"),
        serves: ["generic", "antigravity"],
        readers: ["generic", "codex", "antigravity"],
        exclusiveReader: undefined,
      },
    ]);
    expect(placeSkill(["generic", "antigravity"], global).placements).toEqual([
      { root: "/home/me/.agents/skills", serves: ["generic"], readers: ["generic", "codex"], exclusiveReader: undefined },
      { root: "/home/me/.gemini/config/skills", serves: ["antigravity"], readers: ["antigravity"], exclusiveReader: "antigravity" },
    ]);
  });

  test("a skill carrying Antigravity content gets an .agent/skills copy that shadows the shared one", () => {
    expect(placeSkill(["generic", "codex", "antigravity"], project("apps"), ["antigravity"]).placements).toEqual([
      { root: join("/repo", "apps", ".agent", "skills"), serves: ["antigravity"], readers: ["antigravity"], exclusiveReader: "antigravity" },
      {
        root: join("/repo", "apps", ".agents", "skills"),
        serves: ["generic", "codex"],
        readers: ["generic", "codex", "antigravity"],
        exclusiveReader: undefined,
        shadowed: ["antigravity"],
      },
    ]);
    expect(placeSkill(["antigravity"], project(), ["antigravity"]).placements.map((item) => item.root)).toEqual([join("/repo", ".agent", "skills")]);
    // Globally Antigravity's own root already is exclusive; Codex has no priority root.
    expect(placeSkill(["antigravity"], global, ["antigravity"]).placements.map((item) => item.root)).toEqual(["/home/me/.gemini/config/skills"]);
    expect(placeSkill(["codex"], project(), ["codex"]).placements.map((item) => item.root)).toEqual([join("/repo", ".codex", "skills")]);
  });

  test("a global Codex-only skill has no root", () => {
    expect(placeSkill(["codex"], global)).toEqual({ placements: [], unplaceable: ["codex"] });
    expect(placeSkill(["codex", "generic"], global).placements.map((item) => item.root)).toEqual(["/home/me/.agents/skills"]);
  });
});
