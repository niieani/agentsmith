import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalHome, canonicalRoot } from "./fs.ts";
import { HARNESS_NAMES, type Diagnostic, type HarnessName } from "./types.ts";

/**
 * agentsmith's model of one harness's native discovery.
 *
 * Destinations say where agentsmith writes a harness's own artifacts. Read roots say every skill root the
 * harness discovers, whether or not agentsmith writes there. Placement, content, and collision rules are
 * computed from these two pieces of data rather than from per-harness special cases.
 */
export interface HarnessAdapter {
  name: HarnessName;
  /** Global instruction file, or undefined when no runtime reads a global file for this harness. */
  globalInstruction(home?: string): string | undefined;
  /** Project instruction file for a scope. Harnesses that return the same path share one artifact. */
  projectInstruction(projectRoot: string, scopePath: string): string;
  /**
   * Template and snippet precedence when several harnesses share one instruction file. The highest precedence
   * harness's `<harness>.md` template is tried first; harness snippets render in ascending precedence.
   */
  instructionPrecedence: number;
  /** Instruction content that imports a sibling instruction file instead of repeating it, if supported. */
  instructionImport?(relativePath: string): string;
  /** Global skill root this harness writes its own skills to, or undefined when it has none. */
  globalSkillRoot(home?: string): string | undefined;
  /** Scope-relative skill directory this harness writes its own skills to. */
  projectSkillDirectory: string;
  /** Every global skill root the harness reads. */
  globalSkillReadRoots(home?: string): string[];
  /** Every scope-relative skill directory the harness reads in each discovered directory. */
  projectSkillReadDirectories: readonly string[];
  /**
   * Project file the harness reads instead of its shared instruction file, holding the personal layer, or undefined
   * when the harness has none (generic tools read only the shared layer).
   */
  projectPersonalInstruction?(projectRoot: string, scopePath: string): string;
  /** Diagnostics for an instruction destination; `owned` holds paths agentsmith recorded writing. */
  preflightInstruction?(destination: string, owned: ReadonlySet<string>): Diagnostic[];
  /**
   * Text every instruction file this harness owns alone starts with, such as the `trigger: always_on` front matter of an
   * Antigravity rule. It is not written into a project instruction file the harness shares with others.
   */
  instructionFrontMatter?: string;
  /**
   * False when the harness's own template variant and instruction snippets must not render into the project instruction
   * file it shares: its snippets go to its project rules instead, and its variant is not used. Defaults to true.
   */
  projectHarnessContent?: boolean;
  /**
   * Project rule file holding this harness's own shared instruction snippets as additions to the shared instruction
   * file, for a harness that loads every instruction file cumulatively. Committed like the shared file.
   */
  projectSharedRule?(projectRoot: string, scopePath: string): string;
  /**
   * Project rule file holding the personal layer as additions to the shared instruction file, for a harness that loads
   * every instruction file cumulatively and has no way to read one file instead of another.
   */
  projectPersonalRule?(projectRoot: string, scopePath: string): string;
  /**
   * Scope-relative skill directory only this harness reads and that wins over its other skill directories when a skill
   * name exists in both. A skill carrying this harness's own content is written there.
   */
  projectPrioritySkillDirectory?: string;
}

export function scopeDirectory(projectRoot: string, scopePath: string): string {
  return scopePath === "." ? projectRoot : resolve(projectRoot, scopePath);
}

function codexHome(home: string | undefined): string {
  const actualHome = home ?? canonicalHome();
  if (home !== undefined || !process.env.CODEX_HOME) return join(actualHome, ".codex");
  // Canonicalize only the parent, so a symlinked CODEX_HOME itself is still rejected as a destination ancestor.
  const configured = resolve(process.env.CODEX_HOME.replace(/^~(?=$|\/)/, actualHome));
  return join(canonicalRoot(dirname(configured)), basename(configured));
}

const AGENTS_SKILLS = join(".agents", "skills");
const CODEX_SKILLS = join(".codex", "skills");
const CLAUDE_SKILLS = join(".claude", "skills");
const AGENT_SKILLS = join(".agent", "skills");

/** Front matter that makes Antigravity load a rule file in every conversation. */
export const ALWAYS_ON_FRONT_MATTER = "---\ntrigger: always_on\n---\n\n";

const generic: HarnessAdapter = {
  name: "generic",
  globalInstruction(): undefined {
    return undefined;
  },
  projectInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "AGENTS.md");
  },
  instructionPrecedence: 0,
  globalSkillRoot(home = canonicalHome()): string {
    return join(home, AGENTS_SKILLS);
  },
  projectSkillDirectory: AGENTS_SKILLS,
  globalSkillReadRoots(home = canonicalHome()): string[] {
    return [join(home, AGENTS_SKILLS)];
  },
  projectSkillReadDirectories: [AGENTS_SKILLS],
};

const codex: HarnessAdapter = {
  name: "codex",
  globalInstruction(home): string {
    return join(codexHome(home), "AGENTS.md");
  },
  projectInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "AGENTS.md");
  },
  instructionPrecedence: 10,
  // Codex marks $CODEX_HOME/skills as deprecated; global Codex skills come from generic's ~/.agents/skills.
  globalSkillRoot(): undefined {
    return undefined;
  },
  projectSkillDirectory: CODEX_SKILLS,
  globalSkillReadRoots(home): string[] {
    return [join(home ?? canonicalHome(), AGENTS_SKILLS), join(codexHome(home), "skills")];
  },
  projectSkillReadDirectories: [AGENTS_SKILLS, CODEX_SKILLS],
  projectPersonalInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "AGENTS.override.md");
  },
  // Codex reads AGENTS.override.md instead of AGENTS.md. agentsmith owns the override it writes; any other one hides
  // the generated layer.
  preflightInstruction(destination, owned): Diagnostic[] {
    const override = join(resolve(destination, ".."), "AGENTS.override.md");
    return existsSync(override) && !owned.has(override)
      ? [
          {
            severity: "error",
            code: "codex-override-shadow",
            message: `${override} was not written by agentsmith and shadows the generated ${destination}; move its content into a *.local.md snippet and delete it`,
            path: override,
          },
        ]
      : [];
  },
};

const claude: HarnessAdapter = {
  name: "claude",
  globalInstruction(home = canonicalHome()): string {
    return join(home, ".claude", "CLAUDE.md");
  },
  projectInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "CLAUDE.md");
  },
  instructionPrecedence: 10,
  instructionImport(relativePath): string {
    return `@${relativePath}\n`;
  },
  projectPersonalInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "CLAUDE.local.md");
  },
  globalSkillRoot(home = canonicalHome()): string {
    return join(home, CLAUDE_SKILLS);
  },
  projectSkillDirectory: CLAUDE_SKILLS,
  globalSkillReadRoots(home = canonicalHome()): string[] {
    return [join(home, CLAUDE_SKILLS)];
  },
  projectSkillReadDirectories: [CLAUDE_SKILLS],
};

/**
 * Antigravity (agy) loads every instruction file it finds and lets none replace another, so agentsmith owns a separate
 * always-on rule globally. In a project it reads the shared `AGENTS.md`, and agentsmith adds Antigravity-specific
 * snippets and personal content as rules beside it. It never
 * writes `GEMINI.md`, which Antigravity would load as well.
 */
const antigravity: HarnessAdapter = {
  name: "antigravity",
  globalInstruction(home = canonicalHome()): string {
    return join(home, ".gemini", "config", "rules", "agentsmith.md");
  },
  projectInstruction(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), "AGENTS.md");
  },
  instructionPrecedence: 5,
  instructionFrontMatter: ALWAYS_ON_FRONT_MATTER,
  projectHarnessContent: false,
  projectSharedRule(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), ".agents", "rules", "agentsmith.md");
  },
  projectPersonalRule(projectRoot, scopePath): string {
    return join(scopeDirectory(projectRoot, scopePath), ".agents", "rules", "agentsmith-personal.md");
  },
  globalSkillRoot(home = canonicalHome()): string {
    return join(home, ".gemini", "config", "skills");
  },
  projectSkillDirectory: AGENTS_SKILLS,
  globalSkillReadRoots(home = canonicalHome()): string[] {
    return [join(home, ".gemini", "config", "skills"), join(home, ".gemini", "skills")];
  },
  projectSkillReadDirectories: [AGENTS_SKILLS, AGENT_SKILLS, join("_agents", "skills"), join("_agent", "skills")],
  // Verified with agy 1.5.15: a skill in .agent/skills wins over a same-named one in .agents/skills, and only it is listed.
  projectPrioritySkillDirectory: AGENT_SKILLS,
};

export const HARNESS_ADAPTERS: Record<HarnessName, HarnessAdapter> = { generic, codex, claude, antigravity };

export function getHarnessAdapter(name: HarnessName): HarnessAdapter {
  return HARNESS_ADAPTERS[name];
}

/** Where skills are placed and read: one Global Scope or one project scope directory. */
export type SkillLocation = { mode: "global"; home?: string } | { mode: "project"; projectRoot: string; scopePath: string };

export function skillWriteRoot(harness: HarnessName, location: SkillLocation): string | undefined {
  const adapter = getHarnessAdapter(harness);
  return location.mode === "global"
    ? adapter.globalSkillRoot(location.home)
    : join(scopeDirectory(location.projectRoot, location.scopePath), adapter.projectSkillDirectory);
}

export function skillReadRoots(harness: HarnessName, location: SkillLocation): string[] {
  const adapter = getHarnessAdapter(harness);
  return location.mode === "global"
    ? adapter.globalSkillReadRoots(location.home).map((root) => resolve(root))
    : adapter.projectSkillReadDirectories.map((directory) => resolve(scopeDirectory(location.projectRoot, location.scopePath), directory));
}

/** Every known harness that reads `root` at `location`, in canonical harness order. */
export function skillRootReaders(root: string, location: SkillLocation): HarnessName[] {
  const target = resolve(root);
  return HARNESS_NAMES.filter((harness) => skillReadRoots(harness, location).includes(target));
}

export interface SkillRootPlacement {
  /** Absolute skill root the skill is written to. */
  root: string;
  /** Requested harnesses that discover the skill through this root. */
  serves: HarnessName[];
  /** Every known harness that reads this root, requested or not. */
  readers: HarnessName[];
  /** The only harness reading this root, when exactly one does. Only then may harness-specific content render. */
  exclusiveReader?: HarnessName;
  /** Readers that also find the skill in a root of their own that wins over this one, so this copy is hidden from them. */
  shadowed?: HarnessName[];
}

export interface SkillPlacementResult {
  placements: SkillRootPlacement[];
  /** Requested harnesses that no candidate root could serve without making the skill visible twice. */
  unplaceable: HarnessName[];
}

/** A project skill root only `harness` reads and that wins over its other roots, if the harness has one. */
export function prioritySkillRoot(harness: HarnessName, location: SkillLocation): string | undefined {
  const directory = getHarnessAdapter(harness).projectPrioritySkillDirectory;
  if (location.mode !== "project" || directory === undefined) return undefined;
  return resolve(scopeDirectory(location.projectRoot, location.scopePath), directory);
}

/**
 * Places one skill enabled for `harnesses` so each of them reads it exactly once.
 *
 * Candidate roots are the requested harnesses' own write roots. Roots read by more requested harnesses are
 * chosen first; a root is skipped when it would add nothing new or would make the skill visible twice to a
 * harness already served. For example, generic's `.agents/skills` serves both generic and Codex, so Codex's
 * own `.codex/skills` is not used when both are requested.
 *
 * `specific` names harnesses whose own content the skill carries. A harness with a priority root (Antigravity's
 * `.agent/skills`) gets its own copy there, which hides any copy in a shared root from it.
 */
export function placeSkill(harnesses: readonly HarnessName[], location: SkillLocation, specific: readonly HarnessName[] = []): SkillPlacementResult {
  const requested = HARNESS_NAMES.filter((harness) => harnesses.includes(harness));
  const placements: SkillRootPlacement[] = [];
  const prioritized: HarnessName[] = [];
  for (const harness of requested) {
    const root = specific.includes(harness) ? prioritySkillRoot(harness, location) : undefined;
    if (root === undefined) continue;
    const readers = skillRootReaders(root, location);
    prioritized.push(harness);
    placements.push({ root, serves: [harness], readers, exclusiveReader: readers.length === 1 ? readers[0] : undefined });
  }
  const rest = requested.filter((harness) => !prioritized.includes(harness));
  const candidates: Array<{ root: string; owner: number; serves: HarnessName[]; readers: HarnessName[] }> = [];
  for (const harness of rest) {
    const root = skillWriteRoot(harness, location);
    if (root === undefined) continue;
    const resolved = resolve(root);
    if (candidates.some((candidate) => candidate.root === resolved)) continue;
    const readers = skillRootReaders(resolved, location);
    candidates.push({ root: resolved, owner: HARNESS_NAMES.indexOf(harness), readers, serves: rest.filter((item) => readers.includes(item)) });
  }
  candidates.sort((a, b) => b.serves.length - a.serves.length || a.owner - b.owner);
  const served = new Set<HarnessName>();
  for (const candidate of candidates) {
    if (candidate.serves.length === 0 || candidate.serves.some((harness) => served.has(harness))) continue;
    for (const harness of candidate.serves) served.add(harness);
    const shadowed = candidate.readers.filter((harness) => prioritized.includes(harness));
    placements.push({
      root: candidate.root,
      serves: candidate.serves,
      readers: candidate.readers,
      exclusiveReader: candidate.readers.length === 1 ? candidate.readers[0] : undefined,
      ...(shadowed.length > 0 ? { shadowed } : {}),
    });
  }
  return { placements, unplaceable: rest.filter((harness) => !served.has(harness)) };
}

/**
 * Every Skill Root path suffix agentsmith may write to, relative to a scope directory or the home directory, such as
 * `.agents/skills` and `.gemini/config/skills`. Pruning stops at these roots.
 */
export function skillRootSuffixes(): string[] {
  const home = "/agentsmith-home";
  const suffixes = new Set<string>();
  for (const harness of HARNESS_NAMES) {
    const adapter = getHarnessAdapter(harness);
    suffixes.add(adapter.projectSkillDirectory);
    if (adapter.projectPrioritySkillDirectory !== undefined) suffixes.add(adapter.projectPrioritySkillDirectory);
    const global = adapter.globalSkillRoot(home);
    if (global !== undefined) suffixes.add(global.slice(home.length + 1));
  }
  return [...suffixes];
}
