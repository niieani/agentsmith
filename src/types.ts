/** Harness names removed in a breaking change, mapped to their replacement. */
export const RENAMED_HARNESSES: Readonly<Record<string, string>> = { "claude-code": "claude" };

export const HARNESS_NAMES = ["generic", "codex", "claude"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export interface Budgets {
  instructionLayerBytes?: number;
  effectiveInstructionBytes?: number;
  skillMarkdownBytes?: number;
  /** `[budgets.<harness>]`: overrides of built-in per-harness limits, by limit key. */
  harnesses?: Partial<Record<HarnessName, Record<string, number>>>;
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

/**
 * How agentsmith treats a repository whose committed instruction files belong to someone else: `keep` puts the personal
 * layer after the upstream instructions, `replace` puts it in their place. Either way agentsmith writes only personal,
 * excluded files.
 */
export type UpstreamMode = "keep" | "replace";

/** A profile entry that configures a repository without an agentsmith configuration of its own. */
export interface ProfileProject {
  /** Canonical repository root this entry matches. */
  path?: string;
  /** Remote URL this entry matches, as configured. */
  remote?: string;
  upstream: UpstreamMode;
  harnesses?: HarnessName[];
  template?: string;
  packs: string[];
  skillsEnable: string[];
  skillsDisable: string[];
  /** Profile file declaring the entry. */
  file: string;
}

export interface ProfileConfig {
  harnesses: HarnessName[];
  template: string;
  packs: string[];
  skillsEnable: string[];
  skillsDisable: string[];
  harnessSkills: HarnessSkills;
  budgets: Budgets;
  /** Report unmanaged skills in every Skill Root a selected harness reads. The nearest profile in the chain that sets it wins. */
  exclusive: boolean;
  /** Skill directory name globs left alone in exclusive mode; an ordered union through `extends`. */
  exclusiveAllow: string[];
  /** Resolved `extends` chain, root ancestor first; the last entry is the selected profile. */
  chain: string[];
  /** The profile in the chain that contributed each pack. */
  packProfiles: Record<string, string>;
  /** `[[projects]]` entries, nearest profile first: the first matching entry wins. */
  projects: ProfileProject[];
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
  /** Overrides the project's `exclusive` for this scope. */
  exclusive?: boolean;
  /** Added to the project's `exclusive_allow` for this scope. */
  exclusiveAllow: string[];
}

export interface ProjectConfig {
  harnesses: HarnessName[];
  budgets: Budgets;
  /** Write `@AGENTS.md` as CLAUDE.md when CLAUDE.md would repeat a sibling generated AGENTS.md byte for byte. */
  claudeImportAgentsMd: boolean;
  exclusive: boolean;
  exclusiveAllow: string[];
  /** Set for a third-party repository: agentsmith writes only personal files and never the committed ones. */
  upstream?: UpstreamMode;
  scopes: ScopeConfig[];
}

/** `notice` reports something deliberately left out; it never fails a run, even with `--warnings-as-errors`. */
export type DiagnosticSeverity = "notice" | "warning" | "error";

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

/** A project Instruction Layer file: committed shared content, or a personal file read instead of it. */
export type InstructionLayerKind = "shared" | "personal";

export interface PlannedWrite {
  destination: string;
  content: Uint8Array;
  mode?: number;
  kind: "instruction" | "skill" | "state";
  harness?: HarnessName;
  scope?: string;
  provenance: string[];
  /** Skill files: the skill directory the file belongs to. */
  skillDirectory?: string;
  /** Project instruction files: which layer the file holds. */
  layer?: InstructionLayerKind;
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
