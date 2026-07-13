import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getHarnessAdapter } from "../src/harness.ts";

describe("harness adapters", () => {
  test("maps Codex destinations", () => {
    const adapter = getHarnessAdapter("codex");
    expect(adapter.globalInstruction("/home/me")).toBe("/home/me/.codex/AGENTS.md");
    expect(adapter.globalSkillRoot("/home/me")).toBe("/home/me/.agents/skills");
    expect(adapter.projectInstruction("/repo", "apps/api")).toBe(join("/repo", "apps/api", "AGENTS.md"));
  });

  test("maps Claude Code destinations", () => {
    const adapter = getHarnessAdapter("claude-code");
    expect(adapter.globalInstruction("/home/me")).toBe("/home/me/.claude/CLAUDE.md");
    expect(adapter.projectSkillRoot("/repo", ".")).toBe(join("/repo", ".claude", "skills"));
  });
});
