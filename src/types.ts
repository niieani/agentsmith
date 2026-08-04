export const HARNESS_NAMES = ["codex", "claude-code"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export interface Budgets {
  instructionLayerBytes?: number;
  effectiveInstructionBytes?: number;
  skillMarkdownBytes?: number;
}

export interface MachineConfig {
  source: string;
  profile: string;
}

export interface RootConfig {
  budgets: Budgets;
}

export interface ProfileConfig {
  harnesses: HarnessName[];
  template: string;
  packs: string[];
  skillsEnable: string[];
  skillsDisable: string[];
  budgets: Budgets;
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
}

export interface ProjectConfig {
  harnesses: HarnessName[];
  budgets: Budgets;
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
