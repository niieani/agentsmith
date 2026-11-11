/** Harness names removed in a breaking change, mapped to their replacement. */
export const RENAMED_HARNESSES: Readonly<Record<string, string>> = { "claude-code": "claude" };

export const HARNESS_NAMES = ["generic", "codex", "claude"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export interface Budgets {
  instructionLayerBytes?: number;
  effectiveInstructionBytes?: number;
  skillMarkdownBytes?: number;
}

export interface MachineConfig {
  source: string;
  profile: string;
  /**
   * Configured sandbox home with symlinked ancestors resolved. When set, every agentsmith destination and every piece
   * of agentsmith state resolves under it instead of `$HOME`, and `CODEX_HOME` is ignored. Git keeps the real `$HOME`.
   */
  home?: string;
}

export interface RootConfig {
  budgets: Budgets;
}

/** Skill selections that apply to one harness only, layered after the harness-neutral lists. */
export interface HarnessSkillSelection {
  enable: string[];
  disable: string[];
}

export type HarnessSkills = Partial<Record<HarnessName, HarnessSkillSelection>>;

export interface ProfileConfig {
  harnesses: HarnessName[];
  template: string;
  packs: string[];
  skillsEnable: string[];
  skillsDisable: string[];
  harnessSkills: HarnessSkills;
  budgets: Budgets;
  /** Resolved `extends` chain, root ancestor first; the last entry is the selected profile. */
  chain: string[];
  /** The profile in the chain that contributed each pack. */
  packProfiles: Record<string, string>;
}

export interface PackConfig {
  skills: string[];
}

export interface ScopeConfig {
  path: string;
  template?: string;
  packs: string[];
  harnesses?: HarnessName[];
  skillsEnable: string[];
  skillsDisable: string[];
  harnessSkills: HarnessSkills;
}

export interface ProjectConfig {
  harnesses: HarnessName[];
  budgets: Budgets;
  /** Write `@AGENTS.md` as CLAUDE.md when CLAUDE.md would repeat a sibling generated AGENTS.md byte for byte. */
  claudeImportAgentsMd: boolean;
  scopes: ScopeConfig[];
}

export type DiagnosticSeverity = "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface SourceId {
  owner?: "source" | "project";
  name: string;
  raw: string;
}

export interface Contribution {
  pack: string;
  /** Harness of a harness-specific contribution; undefined for common contributions. */
  harness?: HarnessName;
  slot: string;
  path: string;
  content: string;
}

export interface RenderTrace {
  template: string;
  includes: string[];
  slots: Record<string, string[]>;
}

export interface RenderResult {
  content: string;
  trace: RenderTrace;
  diagnostics: Diagnostic[];
}

export interface PlannedWrite {
  destination: string;
  content: Uint8Array;
  mode?: number;
  kind: "instruction" | "skill" | "state";
  harness?: HarnessName;
  scope?: string;
  provenance: string[];
}

export interface PlannedDelete {
  destination: string;
  kind: "instruction" | "skill";
}

export interface GenerationPlan {
  writes: PlannedWrite[];
  deletes: PlannedDelete[];
  diagnostics: Diagnostic[];
  explanation: unknown;
}

export interface SkillIdentity {
  sourceId: string;
  name: string;
  description: string;
  sourceDir: string;
}
