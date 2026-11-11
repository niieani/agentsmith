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
  preflightInstruction?(destination: string): Diagnostic[];
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
  preflightInstruction(destination): Diagnostic[] {
    const override = join(resolve(destination, ".."), "AGENTS.override.md");
    return existsSync(override)
      ? [
          {
            severity: "error",
            code: "codex-override-shadow",
            message: `${override} shadows the generated ${destination}`,
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
  globalSkillRoot(home = canonicalHome()): string {
    return join(home, CLAUDE_SKILLS);
  },
  projectSkillDirectory: CLAUDE_SKILLS,
  globalSkillReadRoots(home = canonicalHome()): string[] {
    return [join(home, CLAUDE_SKILLS)];
  },
  projectSkillReadDirectories: [CLAUDE_SKILLS],
};

export const HARNESS_ADAPTERS: Record<HarnessName, HarnessAdapter> = { generic, codex, claude };

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
}

export interface SkillPlacementResult {
  placements: SkillRootPlacement[];
  /** Requested harnesses that no candidate root could serve without making the skill visible twice. */
  unplaceable: HarnessName[];
}

/**
 * Places one skill enabled for `harnesses` so each of them reads it exactly once.
 *
 * Candidate roots are the requested harnesses' own write roots. Roots read by more requested harnesses are
 * chosen first; a root is skipped when it would add nothing new or would make the skill visible twice to a
 * harness already served. For example, generic's `.agents/skills` serves both generic and Codex, so Codex's
 * own `.codex/skills` is not used when both are requested.
 */
export function placeSkill(harnesses: readonly HarnessName[], location: SkillLocation): SkillPlacementResult {
  const requested = HARNESS_NAMES.filter((harness) => harnesses.includes(harness));
  const candidates: Array<{ root: string; owner: number; serves: HarnessName[]; readers: HarnessName[] }> = [];
  for (const harness of requested) {
    const root = skillWriteRoot(harness, location);
    if (root === undefined) continue;
    const resolved = resolve(root);
    if (candidates.some((candidate) => candidate.root === resolved)) continue;
    const readers = skillRootReaders(resolved, location);
    candidates.push({ root: resolved, owner: HARNESS_NAMES.indexOf(harness), readers, serves: requested.filter((item) => readers.includes(item)) });
  }
  candidates.sort((a, b) => b.serves.length - a.serves.length || a.owner - b.owner);
  const served = new Set<HarnessName>();
  const placements: SkillRootPlacement[] = [];
  for (const candidate of candidates) {
    if (candidate.serves.length === 0 || candidate.serves.some((harness) => served.has(harness))) continue;
    for (const harness of candidate.serves) served.add(harness);
    placements.push({
      root: candidate.root,
      serves: candidate.serves,
      readers: candidate.readers,
      exclusiveReader: candidate.readers.length === 1 ? candidate.readers[0] : undefined,
    });
  }
  return { placements, unplaceable: requested.filter((harness) => !served.has(harness)) };
}
