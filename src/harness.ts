import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic, HarnessName } from "./types.ts";

export interface HarnessAdapter {
  name: HarnessName;
  instructionName: string;
  projectSkillDirectory: string;
  globalInstruction(home?: string): string;
  globalSkillRoot(home?: string): string;
  projectInstruction(projectRoot: string, scopePath: string): string;
  projectSkillRoot(projectRoot: string, scopePath: string): string;
  preflightInstruction?(destination: string): Diagnostic[];
}

function scopeDirectory(projectRoot: string, scopePath: string): string {
  return scopePath === "." ? projectRoot : resolve(projectRoot, scopePath);
}

const codex: HarnessAdapter = {
  name: "codex",
  instructionName: "AGENTS.md",
  projectSkillDirectory: join(".agents", "skills"),
  globalInstruction(home): string {
    const actualHome = home ?? homedir();
    const codexHome = home === undefined && process.env.CODEX_HOME
      ? resolve(process.env.CODEX_HOME.replace(/^~(?=$|\/)/, actualHome))
      : join(actualHome, ".codex");
    return join(codexHome, "AGENTS.md");
  },
  globalSkillRoot(home = homedir()): string {
    return join(home, ".agents", "skills");
  },
  projectInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "AGENTS.md");
  },
  projectSkillRoot(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), ".agents", "skills");
  },
  preflightInstruction(destination): Diagnostic[] {
    const override = join(resolve(destination, ".."), "AGENTS.override.md");
    return existsSync(override)
      ? [{
          severity: "error",
          code: "codex-override-shadow",
          message: `${override} shadows the generated ${destination}`,
          path: override,
        }]
      : [];
  },
};

const claudeCode: HarnessAdapter = {
  name: "claude-code",
  instructionName: "CLAUDE.md",
  projectSkillDirectory: join(".claude", "skills"),
  globalInstruction(home = homedir()): string {
    return join(home, ".claude", "CLAUDE.md");
  },
  globalSkillRoot(home = homedir()): string {
    return join(home, ".claude", "skills");
  },
  projectInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "CLAUDE.md");
  },
  projectSkillRoot(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), ".claude", "skills");
  },
};

export const HARNESS_ADAPTERS: Record<HarnessName, HarnessAdapter> = {
  codex,
  "claude-code": claudeCode,
};

export function getHarnessAdapter(name: HarnessName): HarnessAdapter {
  return HARNESS_ADAPTERS[name];
}
