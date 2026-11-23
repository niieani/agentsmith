import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  loadMachineConfig,
  loadProfileConfig,
  loadRootConfig,
  MACHINE_CONFIG_PATH,
  mergeBudgets,
  matchesAllow,
  projectSourceRoot,
  resolveConfiguredPath,
  parseSourceId,
} from "./config.ts";
import { walkFiles } from "./fs.ts";
import { gitWorktree } from "./git.ts";
import { checkHarnessLimits } from "./limits.ts";
import { resolveProject } from "./project.ts";
import { globalStatePath, loadGlobalState, loadProjectState, projectStatePath } from "./safety.ts";
import { getHarnessAdapter, placeSkill, skillReadRoots, skillWriteRoot, type SkillLocation } from "./harness.ts";
import { normalizeMarkdown, RESERVED_EDGE_SLOTS, renderMarkdown } from "./markdown.ts";
import {
  isLocalSource,
  loadInstructionContributions,
  personalSourcesUnavailable,
  loadPacks,
  loadSkill,
  loadSkillContributions,
  loadTemplate,
  PersonalSourceSkipped,
  resolvePartial,
  type LoadedPack,
  type LoadedTemplate,
  type SkippedSource,
  type SourceContext,
} from "./source.ts";
import { parseSkillIdentity, scanSkillRoot } from "./skills.ts";
import {
  HARNESS_NAMES,
  type Budgets,
  type Contribution,
  type Diagnostic,
  type GenerationPlan,
  type HarnessName,
  type HarnessSkills,
  type InstructionLayerKind,
  type PlannedWrite,
  type ProjectConfig,
  type RenderTrace,
  type ScopeConfig,
  type SkillIdentity,
  type UpstreamMode,
} from "./types.ts";

const encoder = new TextEncoder();

export interface BuiltPlan extends GenerationPlan {
  mode: "global" | "project";
  sourceRoot?: string;
  projectRoot?: string;
  configPath: string;
  /** The machine config's sandbox home, when one is set; undefined means the real home. */
  home?: string;
  plannedPaths: string[];
  /** Every artifact that can receive snippets, with the slots it declares. */
  slotTargets: SlotTarget[];
  /**
   * Exclusive mode: skill directories in a Skill Root read by a selected harness of an exclusive scope that this plan
   * does not write and `exclusive_allow` does not match. Callers drop those holding recorded artifacts.
   */
  unmanagedSkills: UnmanagedSkill[];
  /** Project: absolute `<scope>/CLAUDE.md` paths Claude must skip because a personal `CLAUDE.local.md` replaces them. */
  claudeMdExcludes: string[];
  /** Project: directories Git must ignore through `info/exclude` because the repository's own ignores cannot be edited. */
  personalExcludes: string[];
  /** Project: set for a third-party repository whose committed files agentsmith never writes. */
  upstream?: UpstreamMode;
  /** Project: where the configuration came from. */
  origin?: "project" | "profile";
}

/** A skill directory that exclusive mode reports because agentsmith does not manage it. */
export interface UnmanagedSkill {
  /** Absolute skill directory path. */
  path: string;
  /** Skill directory name, which `exclusive_allow` globs match. */
  name: string;
  /** Skill Root holding it. */
  root: string;
  scope: string;
  /** Selected harnesses that read the root. */
  harnesses: HarnessName[];
}

/** One planned artifact able to receive pack snippets, and the slots it declares. */
export interface SlotTarget {
  kind: "instruction" | "skill";
  scope: string;
  destination: string;
  /** Instruction: the harnesses sharing the Instruction Layer. Skill: the selected harnesses this copy serves. */
  harnesses: HarnessName[];
  /** Skill only: the one harness reading this skill root, when exactly one does; only it receives harness-specific snippets. */
  exclusiveReader?: HarnessName;
  /** Skill only: the skill name. */
  skill?: string;
  /** Declared slots, including the reserved edge slots of an Instruction Layer. */
  slots: string[];
}

interface ScopeInput {
  path: string;
  template?: string;
  packs: string[];
  harnesses: HarnessName[];
  skillsEnable: string[];
  skillsDisable: string[];
  harnessSkills: HarnessSkills;
  exclusive: boolean;
  exclusiveAllow: string[];
}

interface SkillPlacement {
  /** Configured harnesses that read the root this copy lands in. */
  harnesses: HarnessName[];
  scope: string;
  name: string;
  sourceId: string;
  destinationDir: string;
  /** Rendered SKILL.md of this copy. */
  skillMd?: string;
}

interface EnabledSkill {
  identity: SkillIdentity;
  enabledBy: string[];
  explicitlyEnabled: boolean;
  /** Selected harnesses this skill is enabled for, in canonical order. */
  harnesses: HarnessName[];
}

interface PlannerContext {
  mode: "global" | "project";
  sources: SourceContext;
  /** Project: the same sources restricted to shared inputs; undefined for a third-party repository. */
  sharedSources?: SourceContext;
  upstream?: UpstreamMode;
  /** Personal sources left out because no Source Repository is available. */
  skipped: SkippedSource[];
  /** Absolute paths agentsmith recorded writing (project state), used to tell its own files from foreign ones. */
  ownedPaths: ReadonlySet<string>;
  claudeMdExcludes: string[];
  projectRoot?: string;
  /** Sandbox home from the machine config; undefined means the real home. */
  home?: string;
  budgets: Budgets;
  /** Every harness selected by any scope in this plan. */
  configuredHarnesses: HarnessName[];
  claudeImportAgentsMd: boolean;
  diagnostics: Diagnostic[];
  writes: PlannedWrite[];
  explanations: unknown[];
  skillPlacements: SkillPlacement[];
  slotTargets: SlotTarget[];
  unmanagedSkills: UnmanagedSkill[];
  instructionSizes: Array<{ harness: HarnessName; scope: string; bytes: number }>;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function warning(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
  diagnostics.push({ severity: "warning", code, message, path });
}

function notice(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
  diagnostics.push({ severity: "notice", code, message, path });
}

function error(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
  diagnostics.push({ severity: "error", code, message, path });
}

function stableUnion(values: string[]): string[] {
  return [...new Set(values)];
}

function isAncestorScope(ancestor: string, descendant: string): boolean {
  return ancestor === "." || ancestor === descendant || descendant.startsWith(`${ancestor}/`);
}

function declaredSlots(content: string): Set<string> {
  const slots = new Set<string>();
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      const marker = run[0] as "`" | "~";
      if (!fence) fence = { marker, length: run.length };
      else if (marker === fence.marker && run.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^<!-- agentsmith:(?:required-)?slot ([^\s]+) -->$/.exec(line);
    if (match) slots.add(match[1]!);
  }
  return slots;
}

function scopeDepth(path: string): number {
  return path === "." ? 0 : path.split("/").length;
}

function toScope(input: ScopeConfig, project: ProjectConfig): ScopeInput {
  return {
    path: input.path,
    template: input.template,
    packs: input.packs,
    harnesses: input.harnesses ?? project.harnesses,
    skillsEnable: input.skillsEnable,
    skillsDisable: input.skillsDisable,
    harnessSkills: input.harnessSkills,
    exclusive: input.exclusive ?? project.exclusive,
    exclusiveAllow: stableUnion([...project.exclusiveAllow, ...input.exclusiveAllow]),
  };
}

async function renderContent(
  context: PlannerContext,
  content: string,
  path: string,
  contributions: Contribution[],
  edgeSlots = false,
  target: { sources: SourceContext; diagnostics: Diagnostic[] } = { sources: context.sources, diagnostics: context.diagnostics },
) {
  const rendered = await renderMarkdown({
    content,
    templatePath: path,
    contributions,
    edgeSlots,
    resolveInclude: async (sourceId) => {
      try {
        return await resolvePartial(target.sources, sourceId);
      } catch (cause) {
        if (!(cause instanceof PersonalSourceSkipped)) throw cause;
        // A personal partial is left out; outside the shared layer the run reports it.
        if (!target.sources.sharedOnly) context.skipped.push({ kind: cause.kind, selection: cause.selection });
        return null;
      }
    },
  });
  target.diagnostics.push(...rendered.diagnostics);
  return rendered;
}

function matchingExclusions(exclusions: string[], sourceId: string): string[] {
  const canonical = parseSourceId(sourceId);
  return exclusions.filter((selection) => {
    const id = parseSourceId(selection);
    return id.name === canonical.name && (id.owner === undefined || id.owner === canonical.owner);
  });
}

/**
 * Resolves the skills a scope introduces and the harnesses each is enabled for. For every selected harness the
 * enabled set is `(pack skills + skills_enable - skills_disable) + harness enable - harness disable`.
 */
async function resolveEnabledSkills(context: PlannerContext, scope: ScopeInput, packs: LoadedPack[]): Promise<EnabledSkill[]> {
  const identities = new Map<string, Promise<SkillIdentity | undefined>>();
  const skipped = new Set<string>();
  // A skill only the Source Repository could provide is left out when none is available.
  const load = (selection: string): Promise<SkillIdentity | undefined> => {
    let identity = identities.get(selection);
    if (!identity) {
      identity = loadSkill(context.sources, selection).catch((cause: unknown) => {
        if (!(cause instanceof PersonalSourceSkipped)) throw cause;
        skipped.add(selection);
        context.skipped.push({ kind: "skill", selection });
        return undefined;
      });
      identities.set(selection, identity);
    }
    return identity;
  };
  const harnessSelection = (harness: HarnessName) => scope.harnessSkills[harness] ?? { enable: [], disable: [] };
  await Promise.all([...scope.skillsDisable, ...scope.harnesses.flatMap((harness) => harnessSelection(harness).disable)].map(load));

  const base: Array<{ selection: string; enabledBy?: string }> = [
    ...packs.flatMap((pack) => pack.config.skills.map((selection) => ({ selection, enabledBy: pack.sourceId }))),
    ...scope.skillsEnable.map((selection) => ({ selection })),
  ];
  const resolved = new Map<string, EnabledSkill>();
  const activeBaseExclusions = new Set<string>();
  for (const harness of scope.harnesses) {
    const selection = harnessSelection(harness);
    const activeHarnessExclusions = new Set<string>();
    const candidates: Array<{ selection: string; enabledBy?: string; harnessOnly: boolean }> = [
      ...base.map((item) => ({ ...item, harnessOnly: false })),
      ...selection.enable.map((item) => ({ selection: item, harnessOnly: true })),
    ];
    for (const candidate of candidates) {
      const identity = await load(candidate.selection);
      if (identity === undefined) continue;
      if (!candidate.harnessOnly) {
        const excluded = matchingExclusions(scope.skillsDisable, identity.sourceId);
        for (const match of excluded) activeBaseExclusions.add(match);
        if (excluded.length > 0) continue;
      }
      const excluded = matchingExclusions(selection.disable, identity.sourceId);
      for (const match of excluded) activeHarnessExclusions.add(match);
      if (excluded.length > 0) continue;
      const current = resolved.get(identity.sourceId) ?? { identity, enabledBy: [], explicitlyEnabled: false, harnesses: [] };
      if (candidate.enabledBy) current.enabledBy = stableUnion([...current.enabledBy, candidate.enabledBy]);
      else current.explicitlyEnabled = true;
      if (!current.harnesses.includes(harness)) current.harnesses.push(harness);
      resolved.set(identity.sourceId, current);
    }
    for (const excluded of selection.disable) {
      if (!activeHarnessExclusions.has(excluded) && !skipped.has(excluded)) {
        warning(
          context.diagnostics,
          "skill-exclusion-inactive",
          `Scope ${scope.path} excludes ${excluded} for ${harness}, but that scope does not enable it for ${harness}`,
        );
      }
    }
  }
  for (const excluded of scope.skillsDisable) {
    if (!activeBaseExclusions.has(excluded) && !skipped.has(excluded)) {
      warning(context.diagnostics, "skill-exclusion-inactive", `Scope ${scope.path} excludes ${excluded}, but that scope does not enable it`);
    }
  }
  const skills = [...resolved.values()];
  for (const skill of skills) skill.harnesses = HARNESS_NAMES.filter((harness) => skill.harnesses.includes(harness));
  return skills;
}

function harnessLabel(harnesses: readonly HarnessName[]): string {
  return HARNESS_NAMES.filter((harness) => harnesses.includes(harness)).join("+");
}

interface LayerRender {
  content: string;
  template: LoadedTemplate;
  trace: RenderTrace;
  /** Every snippet loaded for the layer, rendered or not. */
  contributions: Contribution[];
  /** The heading above each slot of the template, in template order. */
  slotHeadings: Array<{ slot: string; heading: string | null }>;
}

interface InstructionGroup {
  /** The Instruction Layer file the harnesses share, such as `<scope>/AGENTS.md`. */
  destination: string;
  harnesses: HarnessName[];
  /** Harnesses whose template variant and snippets render into the file, most specific first. */
  variants: HarnessName[];
  /** Rendered from every input. */
  full: LayerRender;
  /** Project mode: rendered from shared inputs only, or undefined when shared inputs cannot render it. */
  shared?: LayerRender;
  /** Project mode: the personal file a sharing harness reads instead, such as `AGENTS.override.md` for Codex. */
  personalDestination?: string;
  /** The harness reading `personalDestination`. */
  personalHarness?: HarnessName;
}

/** One instruction file this plan writes. */
interface InstructionOutput {
  group: InstructionGroup;
  layer?: InstructionLayerKind;
  destination: string;
  render: LayerRender;
  /** Content replacing the rendered layer, such as upstream instructions followed by the personal layer. */
  content?: string;
  /** Files besides the render's sources that the content came from. */
  extraProvenance?: string[];
  importsFrom?: string;
}

/** A committed instruction file of a third-party repository, unless agentsmith wrote it itself. */
function upstreamInstruction(context: PlannerContext, path: string): string | undefined {
  if (context.ownedPaths.has(path) || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/**
 * Third-party repository: the personal files are all agentsmith writes. With `keep`, Codex's `AGENTS.override.md`
 * repeats the upstream `AGENTS.md` before the personal layer, since Codex reads it instead; Claude reads the upstream
 * `CLAUDE.md` beside `CLAUDE.local.md` anyway, and an upstream `AGENTS.md` that Claude would otherwise fall back to is
 * imported. With `replace`, the upstream `CLAUDE.md` is excluded.
 */
function applyUpstream(context: PlannerContext, outputs: InstructionOutput[]): void {
  for (const item of outputs) {
    const directory = dirname(item.group.destination);
    if (item.group.personalHarness === "codex" && context.upstream === "keep") {
      const upstream = upstreamInstruction(context, item.group.destination);
      if (upstream !== undefined && upstream.trim() !== "") {
        item.content = `${normalizeMarkdown(upstream)}\n${item.render.content}`;
        item.extraProvenance = [item.group.destination];
      }
    }
    if (item.group.personalHarness !== "claude") continue;
    if (context.upstream === "replace") {
      context.claudeMdExcludes.push(item.group.destination);
      continue;
    }
    const claudeFiles = [item.group.destination, join(directory, ".claude", "CLAUDE.md")];
    const agents = join(directory, "AGENTS.md");
    if (claudeFiles.every((path) => !existsSync(path)) && upstreamInstruction(context, agents) !== undefined) {
      item.content = `@AGENTS.md\n\n${item.render.content}`;
      item.extraProvenance = [agents];
    }
  }
}

function isPersonalSkip(cause: unknown): cause is PersonalSourceSkipped {
  return cause instanceof PersonalSourceSkipped;
}

async function renderInstruction(
  context: PlannerContext,
  sources: SourceContext,
  scope: ScopeInput,
  packs: LoadedPack[],
  variants: HarnessName[],
  diagnostics: Diagnostic[],
  /** Harnesses whose snippets render after the variants' snippets without choosing the template. */
  extraSnippets: HarnessName[] = [],
): Promise<LayerRender> {
  const snippetOrder = [...[...variants].reverse(), ...extraSnippets];
  let contributions = (await Promise.all(packs.map((pack) => loadInstructionContributions(pack, snippetOrder)))).flat();
  if (sources.sharedOnly) contributions = contributions.filter((item) => !isLocalSource(item.path));
  const template = await loadTemplate(sources, scope.template!, variants);
  const result = await renderContent(context, template.content, template.path, contributions, true, { sources, diagnostics });
  return { content: result.content, template, trace: result.trace, contributions, slotHeadings: result.slotHeadings };
}

/** Opening line of a personal rule that adds to a shared instruction file. */
export const PERSONAL_RULE_INTRO = "These personal instructions extend AGENTS.md and take precedence over it where they conflict.";

/** Opening line of a shared rule holding one harness's own snippets beside the shared instruction file. */
export const HARNESS_RULE_INTRO = "These instructions extend AGENTS.md for this agent only.";

/**
 * Rule content adding to an instruction file a harness already reads: the snippets `layer` renders and `base` does not,
 * each under the heading its slot has in the template, in template order. Undefined when there are none.
 */
async function additionsBody(
  context: PlannerContext,
  base: LayerRender,
  layer: LayerRender,
  intro: string,
  path: string,
): Promise<{ content: string; trace: RenderTrace } | undefined> {
  const basePaths = new Set(Object.values(base.trace.slots).flat());
  const addedPaths = new Set(
    Object.values(layer.trace.slots)
      .flat()
      .filter((item) => !basePaths.has(item)),
  );
  const added = layer.contributions.filter((item) => addedPaths.has(item.path));
  if (added.length === 0) return undefined;
  const filled = new Set(added.map((item) => item.slot));
  const lines = [intro, ""];
  const directive = (slot: string) => lines.push(`<!-- agentsmith:slot ${slot} -->`, "");
  if (filled.has("prepend")) directive("prepend");
  let heading: string | null = null;
  for (const item of layer.slotHeadings) {
    if (!filled.has(item.slot)) continue;
    if (item.heading !== null && item.heading !== heading) lines.push(item.heading, "");
    heading = item.heading;
    directive(item.slot);
  }
  if (filled.has("append")) directive("append");
  // Diagnostics about these snippets were already reported for the layer itself.
  const rendered = await renderContent(context, lines.join("\n"), path, added, false, { sources: context.sources, diagnostics: [] });
  return { content: rendered.content, trace: rendered.trace };
}

/**
 * Plans the Instruction Layers of one scope. Harnesses whose adapters resolve to the same destination share one
 * artifact: the highest-precedence harness's template variant wins, and every sharing harness's snippets render.
 *
 * In a project, each layer renders twice: the shared layer from shared inputs only goes to the committed file
 * (`AGENTS.md`, `CLAUDE.md`), and the personal layer from every input goes to the file the harness reads instead
 * (`AGENTS.override.md`, `CLAUDE.local.md`), only when it differs.
 */
async function planInstructions(context: PlannerContext, scope: ScopeInput, packs: LoadedPack[], sharedPacks: LoadedPack[]): Promise<void> {
  const membersByDestination = new Map<string, HarnessName[]>();
  for (const harness of scope.harnesses) {
    const adapter = getHarnessAdapter(harness);
    const destination = context.mode === "global" ? adapter.globalInstruction(context.home) : adapter.projectInstruction(context.projectRoot!, scope.path);
    if (destination === undefined) continue;
    const key = resolve(destination);
    membersByDestination.set(key, [...(membersByDestination.get(key) ?? []), harness]);
  }
  if (membersByDestination.size === 0) {
    if (scope.template) {
      warning(
        context.diagnostics,
        "instruction-layer-unsupported",
        `Template ${scope.template} is unused because no harness selected in scope ${scope.path} reads an instruction file there (${scope.harnesses.join(", ")})`,
      );
    }
    return;
  }

  const groups: InstructionGroup[] = [];
  for (const [destination, members] of membersByDestination) {
    // Most specific template variant first; harness snippets render least specific first.
    const sorted = [...members].sort(
      (a, b) => getHarnessAdapter(b).instructionPrecedence - getHarnessAdapter(a).instructionPrecedence || HARNESS_NAMES.indexOf(a) - HARNESS_NAMES.indexOf(b),
    );
    // In a project, a harness without its own project content (Antigravity) renders no variant or snippets into the
    // file it shares; its snippets go to its own rules instead (planHarnessRules).
    const variants = context.mode === "project" ? sorted.filter((harness) => getHarnessAdapter(harness).projectHarnessContent !== false) : sorted;
    if (!scope.template) {
      const contributions = (await Promise.all(packs.map((pack) => loadInstructionContributions(pack, [...variants].reverse())))).flat();
      if (contributions.length > 0) {
        warning(
          context.diagnostics,
          "instruction-contribution-inactive",
          `${contributions.length} instruction contribution(s) are inactive because scope ${scope.path} has no Instruction Layer for ${harnessLabel(members)}`,
        );
      }
      continue;
    }
    let full: LayerRender;
    const lenient = context.mode === "project" && personalSourcesUnavailable(context.sources);
    const fullDiagnostics: Diagnostic[] = [];
    try {
      full = await renderInstruction(context, context.sources, scope, packs, variants, fullDiagnostics);
    } catch (cause) {
      if (!isPersonalSkip(cause)) throw cause;
      context.skipped.push({ kind: cause.kind, selection: cause.selection });
      continue;
    }
    const emptyRequired = lenient ? fullDiagnostics.filter((item) => item.code === "required-slot-empty") : [];
    if (emptyRequired.length > 0) {
      warning(
        context.diagnostics,
        "instruction-layer-skipped-required-slot",
        `Skipped ${destination}: ${emptyRequired.map((item) => item.message).join(" ")} Without a Source Repository, personal packs that may fill it are unavailable.`,
        destination,
      );
      continue;
    }
    context.diagnostics.push(...fullDiagnostics);
    if (context.mode === "project") {
      for (const harness of sorted.filter((item) => !variants.includes(item))) {
        const variant = join(dirname(full.template.path), `${harness}.md`);
        if (!existsSync(variant)) continue;
        notice(
          context.diagnostics,
          "harness-template-variant-project",
          `${variant} is not used in scope ${scope.path}: ${harness} reads the shared ${destination} there, so its template variant applies only to the Global Scope; its project snippets go to its rules`,
          variant,
        );
      }
    }
    for (const harness of members) {
      context.diagnostics.push(...(getHarnessAdapter(harness).preflightInstruction?.(destination, context.ownedPaths) ?? []));
    }
    const group: InstructionGroup = { destination, harnesses: members, variants, full };
    if (context.mode === "project" && context.sharedSources !== undefined) {
      const sharedDiagnostics: Diagnostic[] = [];
      try {
        const shared = await renderInstruction(context, context.sharedSources!, scope, sharedPacks, variants, sharedDiagnostics);
        const failure = sharedDiagnostics.find((item) => item.severity === "error");
        if (failure === undefined) group.shared = shared;
        else
          warning(
            context.diagnostics,
            "shared-layer-incomplete",
            `Shared inputs alone cannot render ${destination} (${failure.code}: ${failure.message}); only personal files carry scope ${scope.path}'s instructions`,
            destination,
          );
      } catch (cause) {
        if (!isPersonalSkip(cause)) throw cause;
        notice(
          context.diagnostics,
          "shared-layer-unavailable",
          `${destination} is not written because template ${scope.template} is not a shared project input; only personal files carry scope ${scope.path}'s instructions`,
          destination,
        );
      }
    }
    if (context.mode === "project") {
      for (const harness of HARNESS_NAMES.filter((item) => members.includes(item))) {
        const personal = getHarnessAdapter(harness).projectPersonalInstruction?.(context.projectRoot!, scope.path);
        if (personal === undefined) continue;
        group.personalDestination = resolve(personal);
        group.personalHarness = harness;
      }
    }
    groups.push(group);
    context.slotTargets.push({
      kind: "instruction",
      scope: scope.path,
      destination,
      harnesses: HARNESS_NAMES.filter((harness) => members.includes(harness)),
      slots: [...new Set([...Object.keys(full.trace.slots), ...RESERVED_EDGE_SLOTS])].sort(),
    });
  }

  const outputs: InstructionOutput[] = [];
  for (const group of groups) {
    if (context.mode === "global") {
      outputs.push({ group, destination: group.destination, render: group.full });
      continue;
    }
    if (group.shared !== undefined) outputs.push({ group, layer: "shared", destination: group.destination, render: group.shared });
    if (group.personalDestination !== undefined && group.full.content !== group.shared?.content) {
      outputs.push({ group, layer: "personal", destination: group.personalDestination, render: group.full });
    }
  }

  if (context.upstream !== undefined) applyUpstream(context, outputs);

  if (context.mode === "project" && context.claudeImportAgentsMd) {
    for (const item of outputs) {
      const importer = item.group.harnesses.length === 1 ? getHarnessAdapter(item.group.harnesses[0]!).instructionImport : undefined;
      if (!importer) continue;
      const sibling = outputs.find(
        (other) =>
          other !== item &&
          other.layer === item.layer &&
          dirname(other.destination) === dirname(item.destination) &&
          (other.content ?? other.render.content) === (item.content ?? item.render.content) &&
          !other.importsFrom,
      );
      if (sibling) item.importsFrom = sibling.destination;
    }
  }

  // Claude reads CLAUDE.local.md beside CLAUDE.md; excluding the shared file leaves only the personal one.
  for (const item of outputs) {
    if (item.layer !== "personal" || item.group.personalHarness !== "claude") continue;
    if (outputs.some((other) => other.layer === "shared" && other.destination === item.group.destination)) {
      context.claudeMdExcludes.push(item.group.destination);
    }
  }

  for (const group of groups) {
    const bytes = utf8Bytes(group.full.content);
    for (const harness of group.harnesses) context.instructionSizes.push({ harness, scope: scope.path, bytes });
    if (context.budgets.instructionLayerBytes && bytes > context.budgets.instructionLayerBytes) {
      warning(
        context.diagnostics,
        "instruction-layer-budget",
        `${group.destination} is ${bytes} bytes, exceeding the ${context.budgets.instructionLayerBytes}-byte instruction layer budget`,
        group.destination,
      );
    }
  }

  for (const item of outputs) {
    const harnesses = item.layer === "personal" ? [item.group.personalHarness!] : item.group.harnesses;
    const importer = getHarnessAdapter(item.group.harnesses[0]!).instructionImport;
    // A global file one harness owns alone, such as Antigravity's rule, starts with that harness's front matter. Project
    // instruction files are shared with every tool reading AGENTS.md.
    const frontMatter =
      context.mode === "global" && item.group.harnesses.length === 1 ? (getHarnessAdapter(item.group.harnesses[0]!).instructionFrontMatter ?? "") : "";
    const content = frontMatter + (item.importsFrom && importer ? importer(basename(item.importsFrom)) : (item.content ?? item.render.content));
    const provenance = [
      ...(item.extraProvenance ?? []),
      item.render.template.path,
      ...Object.values(item.render.trace.slots).flat(),
      ...item.render.trace.includes,
    ];
    context.writes.push({
      destination: item.destination,
      content: encoder.encode(content),
      kind: "instruction",
      harness: harnesses[0],
      scope: scope.path,
      provenance,
      ...(item.layer ? { layer: item.layer } : {}),
    });
    context.explanations.push({
      kind: "instruction",
      ...(item.layer ? { layer: item.layer } : {}),
      harness: harnessLabel(harnesses),
      harnesses: HARNESS_NAMES.filter((harness) => harnesses.includes(harness)),
      scope: scope.path,
      destination: item.destination,
      ...(item.importsFrom ? { importsFrom: item.importsFrom } : {}),
      template: item.render.template.path,
      templateSelection: item.render.template.selection,
      templateSourceId: item.render.template.sourceId,
      packs: (item.layer === "shared" ? sharedPacks : packs).map((pack) => pack.sourceId),
      packSources: (item.layer === "shared" ? sharedPacks : packs).map((pack) => ({
        selection: pack.selection,
        sourceId: pack.sourceId,
        directory: pack.directory,
      })),
      trace: item.render.trace,
      bytes: utf8Bytes(frontMatter + (item.content ?? item.render.content)),
    });
  }

  if (context.mode === "project") {
    for (const group of groups) await planHarnessRules(context, scope, group, packs, sharedPacks);
  }
}

/**
 * Plans the project rules of each harness that loads every instruction file and so cannot read one file instead of the
 * shared one (Antigravity). Both rules add to the shared file under its slot headings:
 *
 * - the shared rule holds the harness's own snippets from shared inputs, committed with the shared file;
 * - the personal rule holds what the harness would see from every input but does not get from the shared file and the
 *   shared rule, excluded from Git. Without a shared layer (a third-party repository, or a template that is not a shared
 *   input) the whole layer is personal.
 */
async function planHarnessRules(
  context: PlannerContext,
  scope: ScopeInput,
  group: InstructionGroup,
  packs: LoadedPack[],
  sharedPacks: LoadedPack[],
): Promise<void> {
  for (const harness of group.harnesses) {
    const adapter = getHarnessAdapter(harness);
    const personalPath = adapter.projectPersonalRule?.(context.projectRoot!, scope.path);
    if (personalPath === undefined) continue;
    const own = adapter.projectHarnessContent === false && !group.variants.includes(harness) ? [harness] : [];
    const hasOwn =
      own.length > 0 && (await Promise.all(packs.map((pack) => loadInstructionContributions(pack, own)))).flat().some((item) => item.harness === harness);
    let full = group.full;
    if (hasOwn) {
      const diagnostics: Diagnostic[] = [];
      full = await renderInstruction(context, context.sources, scope, packs, group.variants, diagnostics, own);
      // Report only what the harness's own snippets add; the rest was reported for the shared file.
      const seen = new Set(context.diagnostics.map((item) => `${item.code}\0${item.message}`));
      context.diagnostics.push(...diagnostics.filter((item) => !seen.has(`${item.code}\0${item.message}`)));
    }
    let base = group.shared;
    const sharedPath = adapter.projectSharedRule?.(context.projectRoot!, scope.path);
    if (hasOwn && group.shared !== undefined && sharedPath !== undefined) {
      const diagnostics: Diagnostic[] = [];
      let shared: LayerRender | undefined;
      try {
        shared = await renderInstruction(context, context.sharedSources!, scope, sharedPacks, group.variants, diagnostics, own);
      } catch (cause) {
        if (!isPersonalSkip(cause)) throw cause;
      }
      if (shared !== undefined && !diagnostics.some((item) => item.severity === "error")) {
        const destination = resolve(sharedPath);
        const body = await additionsBody(context, group.shared, shared, HARNESS_RULE_INTRO, destination);
        if (body !== undefined) {
          planRule(context, scope, group, harness, destination, body, "shared", sharedPacks);
          base = shared;
        }
      }
    }
    const destination = resolve(personalPath);
    let body: { content: string; trace: RenderTrace } | undefined;
    if (base === undefined) {
      const intro = context.upstream === undefined ? "" : `${PERSONAL_RULE_INTRO}\n\n`;
      body = { content: normalizeMarkdown(intro + full.content), trace: full.trace };
    } else {
      body = await additionsBody(context, base, full, PERSONAL_RULE_INTRO, destination);
    }
    if (body !== undefined) planRule(context, scope, group, harness, destination, body, "personal", packs);
  }
}

function planRule(
  context: PlannerContext,
  scope: ScopeInput,
  group: InstructionGroup,
  harness: HarnessName,
  destination: string,
  body: { content: string; trace: RenderTrace },
  layer: InstructionLayerKind,
  packs: LoadedPack[],
): void {
  const content = (getHarnessAdapter(harness).instructionFrontMatter ?? "") + body.content;
  context.writes.push({
    destination,
    content: encoder.encode(content),
    kind: "instruction",
    harness,
    scope: scope.path,
    provenance: [group.full.template.path, ...Object.values(body.trace.slots).flat(), ...body.trace.includes],
    layer,
  });
  context.explanations.push({
    kind: "instruction",
    layer,
    harness,
    harnesses: [harness],
    scope: scope.path,
    destination,
    extends: group.destination,
    template: group.full.template.path,
    templateSelection: group.full.template.selection,
    templateSourceId: group.full.template.sourceId,
    packs: packs.map((pack) => pack.sourceId),
    packSources: packs.map((pack) => ({ selection: pack.selection, sourceId: pack.sourceId, directory: pack.directory })),
    trace: body.trace,
    bytes: utf8Bytes(content),
  });
}

/**
 * Project lints for a harness that loads every instruction file it finds (Antigravity): a `GEMINI.md` beside the shared
 * `AGENTS.md` loads as well, and `upstream = "replace"` cannot hide the upstream files from it.
 */
function lintCumulativeInstructions(context: PlannerContext, scope: ScopeInput): void {
  for (const harness of scope.harnesses) {
    if (getHarnessAdapter(harness).projectPersonalRule === undefined) continue;
    const agents = getHarnessAdapter(harness).projectInstruction(context.projectRoot!, scope.path);
    const gemini = join(dirname(agents), "GEMINI.md");
    if (existsSync(gemini) && (existsSync(agents) || scope.template !== undefined)) {
      warning(
        context.diagnostics,
        "gemini-md-beside-agents-md",
        `${harness} loads both ${agents} and ${gemini}; move GEMINI.md's content into AGENTS.md (or its inputs) and delete it, or instructions in both apply twice`,
        gemini,
      );
    }
    if (context.upstream === "replace") {
      warning(
        context.diagnostics,
        "upstream-replace-cumulative",
        `upstream = "replace" cannot hide the upstream instructions from ${harness} in scope ${scope.path}: it loads every AGENTS.md, GEMINI.md and always-on rule, so it reads the upstream files and the personal layer together`,
      );
    }
  }
}

function skillLocation(context: PlannerContext, scope: ScopeInput): SkillLocation {
  return context.mode === "global" ? { mode: "global", home: context.home } : { mode: "project", projectRoot: context.projectRoot!, scopePath: scope.path };
}

/**
 * Plans the skills one scope introduces. Each skill is written once per distinct root its harnesses read
 * (see `placeSkill`). Harness-specific skill-slot snippets render only into a root read exclusively by that harness;
 * a selected harness's snippet that a shared root would hide is an error.
 */
async function planSkills(context: PlannerContext, scope: ScopeInput, packs: LoadedPack[]): Promise<void> {
  const skills = await resolveEnabledSkills(context, scope, packs);
  const contributions = (await Promise.all(packs.map((pack) => loadSkillContributions(pack, scope.harnesses)))).flat();
  const usedContributionPaths = new Set<string>();
  const location = skillLocation(context, scope);

  const lenient = context.mode === "project" && personalSourcesUnavailable(context.sources);
  for (const enabled of skills) {
    const skill = enabled.identity;
    const sourceId = skill.sourceId;
    const skillDir = skill.sourceDir;
    const before = {
      diagnostics: context.diagnostics.length,
      writes: context.writes.length,
      explanations: context.explanations.length,
      placements: context.skillPlacements.length,
      slotTargets: context.slotTargets.length,
    };
    const files = await walkFiles(skillDir);
    const markdownFiles = files.filter((file) => file.relativePath.endsWith(".md"));
    const slotsByFile = new Map<string, Set<string>>();
    const ownersBySlot = new Map<string, string[]>();
    for (const file of markdownFiles) {
      const slots = declaredSlots(new TextDecoder().decode(file.content));
      slotsByFile.set(file.absolutePath, slots);
      for (const slot of slots) ownersBySlot.set(slot, [...(ownersBySlot.get(slot) ?? []), file.absolutePath]);
    }
    for (const [slot, owners] of ownersBySlot) {
      if (owners.length > 1)
        error(context.diagnostics, "skill-slot-duplicate", `Skill ${skill.name} declares slot ${slot} in multiple files: ${owners.join(", ")}`);
    }

    // A harness whose own snippets fill a slot of this skill gets a copy in its priority root, if it has one.
    const specific = enabled.harnesses.filter((harness) => contributions.some((item) => item.harness === harness && ownersBySlot.has(item.slot)));
    const { placements, unplaceable } = placeSkill(enabled.harnesses, location, specific);
    for (const harness of unplaceable) {
      const readable = skillReadRoots(harness, location);
      const alternatives = HARNESS_NAMES.filter((other) => {
        const root = other === harness ? undefined : skillWriteRoot(other, location);
        return root !== undefined && readable.includes(resolve(root));
      });
      error(
        context.diagnostics,
        "skill-harness-unplaceable",
        `Skill ${skill.name} is enabled for ${harness} in scope ${scope.path}, but ${harness} has no ${context.mode} skill root of its own${
          alternatives.length > 0 ? `; enable it for ${alternatives.join(" or ")} instead, whose skill root ${harness} also reads` : ""
        }`,
        skillDir,
      );
    }

    for (const placement of placements) {
      const selectedReaders = placement.readers.filter((harness) => scope.harnesses.includes(harness) && !placement.shadowed?.includes(harness));
      const consumed = contributions.filter((item) => ownersBySlot.has(item.slot));
      for (const item of consumed) {
        if (item.harness === undefined || item.harness === placement.exclusiveReader || !selectedReaders.includes(item.harness)) continue;
        usedContributionPaths.add(item.path);
        error(
          context.diagnostics,
          "skill-harness-content-shared-root",
          `Skill ${skill.name} is written to ${placement.root}, which ${selectedReaders.join(", ")} all read, so ${item.harness}-specific snippet for slot ${item.slot} cannot apply there; make the snippet common or enable the skill for ${item.harness} without ${selectedReaders.filter((harness) => harness !== item.harness).join(", ")}`,
          item.path,
        );
      }
      const applicable = contributions.filter((item) => item.harness === undefined || item.harness === placement.exclusiveReader);
      for (const item of applicable) if (ownersBySlot.has(item.slot)) usedContributionPaths.add(item.path);

      const destinationDir = join(placement.root, skill.name);
      const writeHarness = placement.serves[0];
      context.slotTargets.push({
        kind: "skill",
        scope: scope.path,
        destination: destinationDir,
        harnesses: placement.serves,
        exclusiveReader: placement.exclusiveReader,
        skill: skill.name,
        slots: [...ownersBySlot.keys()].sort(),
      });
      const skillPlacement: SkillPlacement = {
        // A reader that finds this skill's own copy in a root that wins does not see this one.
        harnesses: placement.readers.filter((harness) => context.configuredHarnesses.includes(harness) && !placement.shadowed?.includes(harness)),
        scope: scope.path,
        name: skill.name,
        sourceId,
        destinationDir,
      };
      context.skillPlacements.push(skillPlacement);
      let markdownBytes = 0;
      let supportBytes = 0;
      const fileExplanations: unknown[] = [];
      for (const file of files) {
        const destination = join(destinationDir, file.relativePath);
        if (file.relativePath.endsWith(".md")) {
          const fileContributions = applicable.filter((item) => slotsByFile.get(file.absolutePath)?.has(item.slot));
          const rendered = await renderContent(context, new TextDecoder().decode(file.content), file.absolutePath, fileContributions);
          const content = encoder.encode(rendered.content);
          if (file.relativePath === "SKILL.md") {
            skillPlacement.skillMd = rendered.content;
            try {
              parseSkillIdentity(rendered.content, skillDir, sourceId);
            } catch (cause) {
              error(context.diagnostics, "rendered-skill-invalid", cause instanceof Error ? cause.message : String(cause), file.absolutePath);
            }
          }
          markdownBytes += content.byteLength;
          context.writes.push({
            destination,
            content,
            mode: file.mode,
            kind: "skill",
            harness: writeHarness,
            scope: scope.path,
            provenance: [file.absolutePath, ...Object.values(rendered.trace.slots).flat(), ...rendered.trace.includes],
            skillDirectory: destinationDir,
          });
          fileExplanations.push({ path: file.relativePath, trace: rendered.trace, bytes: content.byteLength });
        } else {
          supportBytes += file.content.byteLength;
          context.writes.push({
            destination,
            content: file.content,
            mode: file.mode,
            kind: "skill",
            harness: writeHarness,
            scope: scope.path,
            provenance: [file.absolutePath],
            skillDirectory: destinationDir,
          });
          fileExplanations.push({ path: file.relativePath, supportBytes: file.content.byteLength });
        }
      }
      if (context.budgets.skillMarkdownBytes && markdownBytes > context.budgets.skillMarkdownBytes) {
        warning(
          context.diagnostics,
          "skill-markdown-budget",
          `${skill.name} is ${markdownBytes} Markdown bytes, exceeding the ${context.budgets.skillMarkdownBytes}-byte skill budget`,
          skillDir,
        );
      }
      context.explanations.push({
        kind: "skill",
        harness: harnessLabel(placement.serves),
        harnesses: placement.serves,
        readers: placement.readers,
        scope: scope.path,
        sourceId,
        name: skill.name,
        destination: destinationDir,
        enabledBy: enabled.enabledBy,
        explicitlyEnabled: enabled.explicitlyEnabled,
        scopeExclusions: scope.skillsDisable,
        packSources: packs.map((pack) => ({ selection: pack.selection, sourceId: pack.sourceId, directory: pack.directory })),
        markdownBytes,
        supportBytes,
        files: fileExplanations,
      });
    }

    // Without a Source Repository, a required slot may be empty only because the personal packs that fill it are
    // missing; the skill is left out instead of failing the run.
    const emptyRequired = lenient ? context.diagnostics.slice(before.diagnostics).filter((item) => item.code === "required-slot-empty") : [];
    if (emptyRequired.length > 0) {
      context.diagnostics.length = before.diagnostics;
      context.writes.length = before.writes;
      context.explanations.length = before.explanations;
      context.skillPlacements.length = before.placements;
      context.slotTargets.length = before.slotTargets;
      warning(
        context.diagnostics,
        "skill-skipped-required-slot",
        `Skipped skill ${skill.name}: ${emptyRequired.map((item) => item.message).join(" ")} Without a Source Repository, personal packs that may fill it are unavailable.`,
        skillDir,
      );
    }
  }

  for (const contribution of contributions) {
    if (usedContributionPaths.has(contribution.path)) continue;
    warning(
      context.diagnostics,
      "skill-contribution-inactive",
      `Pack ${contribution.pack} contributes to skill slot ${contribution.slot}, but no enabled skill declares that slot in scope ${scope.path} for ${
        contribution.harness ?? harnessLabel(scope.harnesses)
      }`,
      contribution.path,
    );
  }
}

function sharedHarnesses(a: readonly HarnessName[], b: readonly HarnessName[]): HarnessName[] {
  return a.filter((harness) => b.includes(harness));
}

function validatePlannedSkillCollisions(context: PlannerContext): void {
  const placements = context.skillPlacements;
  for (let left = 0; left < placements.length; left++) {
    for (let right = left + 1; right < placements.length; right++) {
      const a = placements[left]!;
      const b = placements[right]!;
      const shared = sharedHarnesses(a.harnesses, b.harnesses);
      if (shared.length === 0 || a.name !== b.name) continue;
      const sameChain = context.mode === "global" || isAncestorScope(a.scope, b.scope) || isAncestorScope(b.scope, a.scope);
      if (sameChain) {
        error(
          context.diagnostics,
          "skill-name-collision",
          `Skill ${a.name} is visible more than once for ${shared.join(", ")}: ${a.destinationDir} (${a.sourceId}) and ${b.destinationDir} (${b.sourceId})`,
        );
      }
    }
  }
}

/** Names of the entries in a Skill Root that can be skills: directories and symlinks, skipping hidden ones such as `.system`. */
export async function skillDirectoryNames(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort();
}

/** Exclusive mode: every skill directory a selected harness reads in an exclusive scope that this plan does not write. */
async function findExclusiveUnmanagedSkills(context: PlannerContext, scopes: ScopeInput[]): Promise<void> {
  const planned = new Set(context.skillPlacements.map((item) => resolve(item.destinationDir)));
  const found = new Map<string, UnmanagedSkill>();
  for (const scope of scopes) {
    if (!scope.exclusive) continue;
    const location = skillLocation(context, scope);
    for (const harness of scope.harnesses) {
      for (const root of skillReadRoots(harness, location)) {
        for (const name of await skillDirectoryNames(root)) {
          const path = join(root, name);
          if (planned.has(path) || matchesAllow(name, scope.exclusiveAllow)) continue;
          const entry = found.get(path) ?? { path, name, root, scope: scope.path, harnesses: [] };
          if (!entry.harnesses.includes(harness)) entry.harnesses.push(harness);
          found.set(path, entry);
        }
      }
    }
  }
  context.unmanagedSkills = [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function validateUnmanagedSkillCollisions(context: PlannerContext, scopes: ScopeInput[]): Promise<void> {
  const plannedDirs = new Set(context.skillPlacements.map((item) => resolve(item.destinationDir)));
  const roots = new Map<string, { scope: string; harnesses: HarnessName[] }>();
  const addRoot = (root: string, scope: string, harness: HarnessName): void => {
    const key = resolve(root);
    const entry = roots.get(key) ?? { scope, harnesses: [] };
    if (!entry.harnesses.includes(harness)) entry.harnesses.push(harness);
    roots.set(key, entry);
  };
  if (context.mode === "project") {
    for (const scope of scopes) {
      for (const harness of scope.harnesses) {
        const segments = scope.path === "." ? [] : scope.path.split("/");
        for (let index = 0; index <= segments.length; index++) {
          const ancestor = index === 0 ? "." : segments.slice(0, index).join("/");
          for (const root of skillReadRoots(harness, { mode: "project", projectRoot: context.projectRoot!, scopePath: ancestor }))
            addRoot(root, ancestor, harness);
        }
      }
    }
    for (const harness of context.configuredHarnesses) {
      for (const discovered of await discoverNativeSkillRoots(context.projectRoot!, harness)) addRoot(discovered.root, discovered.scope, harness);
    }
  }
  for (const harness of context.configuredHarnesses) {
    for (const root of skillReadRoots(harness, { mode: "global", home: context.home })) addRoot(root, "<global>", harness);
  }

  const unmanaged: Array<SkillIdentity & { harnesses: HarnessName[]; scope: string }> = [];
  for (const [root, metadata] of roots) {
    const scanned = await scanSkillRoot(root);
    context.diagnostics.push(...scanned.diagnostics);
    for (const skill of scanned.skills) {
      // A skill agentsmith recorded writing and no longer plans there is stale and is deleted, not a foreign skill.
      if (plannedDirs.has(resolve(skill.sourceDir)) || context.ownedPaths.has(resolve(skill.sourceDir, "SKILL.md"))) continue;
      unmanaged.push({ ...skill, ...metadata });
    }
  }
  // In exclusive mode an unmanaged skill is reported (and can be backed up) on its own, instead of failing planning.
  const exclusive = new Set(context.unmanagedSkills.map((item) => item.path));
  for (const planned of context.skillPlacements) {
    for (const external of unmanaged) {
      if (exclusive.has(resolve(external.sourceDir))) continue;
      if (planned.name !== external.name || sharedHarnesses(planned.harnesses, external.harnesses).length === 0) continue;
      const visible = external.scope === "<global>" || isAncestorScope(external.scope, planned.scope) || isAncestorScope(planned.scope, external.scope);
      if (visible)
        error(
          context.diagnostics,
          "planned-unmanaged-skill-collision",
          `Planned skill ${planned.name} at ${planned.scope} collides with visible skill ${external.sourceDir}`,
          external.sourceDir,
        );
    }
  }
  for (let left = 0; left < unmanaged.length; left++) {
    for (let right = left + 1; right < unmanaged.length; right++) {
      const a = unmanaged[left]!;
      const b = unmanaged[right]!;
      if (a.name !== b.name || sharedHarnesses(a.harnesses, b.harnesses).length === 0) continue;
      const visible = a.scope === "<global>" || b.scope === "<global>" || isAncestorScope(a.scope, b.scope) || isAncestorScope(b.scope, a.scope);
      if (visible)
        warning(context.diagnostics, "unmanaged-skill-collision", `Visible unmanaged skills share name ${a.name}: ${a.sourceDir} and ${b.sourceDir}`);
    }
  }
}

/** Every harness-specific top-level directory that holds skill roots, such as `.agents`, `.codex`, and `.claude`. */
const SKILL_ROOT_PARENTS = new Set(
  HARNESS_NAMES.flatMap((harness) => getHarnessAdapter(harness).projectSkillReadDirectories.map((directory) => directory.split(/[\\/]/)[0]!)),
);

async function discoverNativeSkillRoots(projectRoot: string, harness: HarnessName): Promise<Array<{ root: string; scope: string }>> {
  const adapter = getHarnessAdapter(harness);
  const found: Array<{ root: string; scope: string }> = [];
  const excluded = new Set([".git", ".hg", ".svn", "node_modules"]);

  async function visit(directory: string): Promise<void> {
    for (const skillDirectory of adapter.projectSkillReadDirectories) {
      const candidate = join(directory, skillDirectory);
      if (existsSync(candidate)) {
        const scope = relative(projectRoot, directory).replaceAll("\\", "/") || ".";
        found.push({ root: candidate, scope });
      }
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      if (SKILL_ROOT_PARENTS.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (child !== projectRoot && existsSync(join(child, ".git"))) continue;
      await visit(child);
    }
  }

  await visit(projectRoot);
  return found;
}

function validateEffectiveInstructionBudgets(context: PlannerContext): void {
  for (const item of context.instructionSizes) {
    const effective = context.instructionSizes
      .filter((candidate) => candidate.harness === item.harness && isAncestorScope(candidate.scope, item.scope))
      .reduce((sum, candidate) => sum + candidate.bytes, 0);
    if (context.budgets.effectiveInstructionBytes && effective > context.budgets.effectiveInstructionBytes) {
      warning(
        context.diagnostics,
        "effective-instruction-budget",
        `${item.harness} effective instructions at ${item.scope} are ${effective} bytes, exceeding the ${context.budgets.effectiveInstructionBytes}-byte budget`,
      );
    }
  }
}

function coalesceWrites(context: PlannerContext): void {
  const byDestination = new Map<string, PlannedWrite>();
  for (const write of context.writes) {
    const destination = resolve(write.destination);
    const existing = byDestination.get(destination);
    if (!existing) {
      byDestination.set(destination, { ...write, destination });
      continue;
    }
    if (!Buffer.from(existing.content).equals(Buffer.from(write.content)) || existing.mode !== write.mode) {
      error(context.diagnostics, "physical-destination-collision", `Different artifacts resolve to the same destination: ${destination}`, destination);
    } else {
      existing.provenance = stableUnion([...existing.provenance, ...write.provenance]);
    }
  }
  context.writes = [...byDestination.values()].sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
}

/** One notice per personal source left out because no Source Repository is configured. */
function reportSkippedSources(context: PlannerContext): void {
  const seen = new Set<string>();
  for (const item of context.skipped) {
    const key = `${item.kind}\0${item.selection}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notice(
      context.diagnostics,
      "personal-input-skipped",
      `Skipped ${item.kind} ${JSON.stringify(item.selection)}: it is not a shared project input, and no Source Repository is configured to provide it`,
    );
  }
}

async function planScopes(context: PlannerContext, scopes: ScopeInput[]): Promise<void> {
  const sorted = [...scopes].sort((a, b) => scopeDepth(a.path) - scopeDepth(b.path) || (a.path < b.path ? -1 : 1));
  const loadedScopes = sorted.map((scope) => ({
    scope,
    packs: loadPacks(context.sources, scope.packs, context.skipped),
    sharedPacks: context.sharedSources === undefined ? [] : loadPacks(context.sharedSources, scope.packs),
  }));
  for (let ancestorIndex = 0; ancestorIndex < loadedScopes.length; ancestorIndex += 1) {
    const ancestor = loadedScopes[ancestorIndex]!;
    const inherited = new Set(ancestor.packs.map((pack) => pack.sourceId));
    for (let childIndex = ancestorIndex + 1; childIndex < loadedScopes.length; childIndex += 1) {
      const child = loadedScopes[childIndex]!;
      if (!isAncestorScope(ancestor.scope.path, child.scope.path)) continue;
      const repeated = child.packs.find((pack) => inherited.has(pack.sourceId));
      if (repeated) {
        throw new Error(
          `scope ${JSON.stringify(child.scope.path)} repeats inherited pack source ${repeated.sourceId} from scope ${JSON.stringify(ancestor.scope.path)}`,
        );
      }
    }
  }
  for (const { scope, packs, sharedPacks } of loadedScopes) {
    for (const pack of packs) {
      const coupledSkillRoot = join(pack.directory, "skills");
      if (existsSync(coupledSkillRoot)) {
        error(
          context.diagnostics,
          "skill-contribution-layout",
          `Pack ${pack.sourceId} uses skill-name-coupled contributions; move reusable snippets from skills/<skill>/<slot>/ to skill-slots/<slot>/`,
          coupledSkillRoot,
        );
      }
    }
    await planInstructions(context, scope, packs, sharedPacks);
    if (context.mode === "project") lintCumulativeInstructions(context, scope);
    await planSkills(context, scope, packs);
  }
  reportSkippedSources(context);
  validatePlannedSkillCollisions(context);
  await findExclusiveUnmanagedSkills(context, sorted);
  await validateUnmanagedSkillCollisions(context, sorted);
  validateEffectiveInstructionBudgets(context);
  coalesceWrites(context);
  context.diagnostics.push(
    ...checkHarnessLimits({
      mode: context.mode,
      projectRoot: context.projectRoot,
      home: context.home,
      scopes: sorted.map((scope) => ({ path: scope.path, harnesses: scope.harnesses })),
      writes: context.writes,
      skills: context.skillPlacements.flatMap((item) =>
        item.skillMd === undefined ? [] : [{ destinationDir: item.destinationDir, name: item.name, harnesses: item.harnesses, skillMd: item.skillMd }],
      ),
      ownedPaths: context.ownedPaths,
      claudeMdExcludes: context.claudeMdExcludes,
      overrides: context.budgets.harnesses,
    }),
  );
}

interface ProfileExplanation {
  name: string;
  chain: string[];
  packs: Array<{ pack: string; profile: string }>;
}

function builtPlan(context: PlannerContext, configPath: string, profile?: ProfileExplanation): BuiltPlan {
  return {
    mode: context.mode,
    sourceRoot: context.sources.sourceRoot,
    projectRoot: context.projectRoot,
    configPath,
    home: context.home,
    writes: context.writes,
    deletes: [],
    diagnostics: context.diagnostics,
    explanation: {
      mode: context.mode,
      sourceRoot: context.sources.sourceRoot,
      projectRoot: context.projectRoot,
      ...(profile === undefined ? {} : { profile }),
      artifacts: context.explanations,
      diagnostics: context.diagnostics,
    },
    plannedPaths: context.writes.filter((write) => write.kind !== "state").map((write) => write.destination),
    slotTargets: context.slotTargets,
    unmanagedSkills: context.unmanagedSkills,
    claudeMdExcludes: [...new Set(context.claudeMdExcludes)].sort(),
    personalExcludes: [],
  };
}

export async function buildGlobalPlan(configPath = MACHINE_CONFIG_PATH): Promise<BuiltPlan> {
  const resolvedConfig = resolveConfiguredPath(configPath, join(process.cwd(), "config.toml"));
  const machine = loadMachineConfig(resolvedConfig);
  const root = loadRootConfig(machine.source);
  const profile = loadProfileConfig(machine.source, machine.profile);
  const context: PlannerContext = {
    mode: "global",
    sources: { sourceRoot: machine.source },
    home: machine.home,
    skipped: [],
    ownedPaths: await ownedGlobalPaths(machine.home),
    claudeMdExcludes: [],
    budgets: mergeBudgets(root.budgets, profile.budgets),
    configuredHarnesses: profile.harnesses,
    claudeImportAgentsMd: false,
    diagnostics: [],
    writes: [],
    explanations: [],
    skillPlacements: [],
    slotTargets: [],
    unmanagedSkills: [],
    instructionSizes: [],
  };
  await planScopes(context, [
    {
      path: "<global>",
      template: profile.template,
      packs: profile.packs,
      harnesses: profile.harnesses,
      skillsEnable: profile.skillsEnable,
      skillsDisable: profile.skillsDisable,
      harnessSkills: profile.harnessSkills,
      exclusive: profile.exclusive,
      exclusiveAllow: profile.exclusiveAllow,
    },
  ]);
  return builtPlan(context, resolvedConfig, {
    name: machine.profile,
    chain: profile.chain,
    packs: profile.packs.map((pack) => ({ pack, profile: profile.packProfiles[pack]! })),
  });
}

/** Absolute paths recorded in the global state, or none when it is unreadable. */
async function ownedGlobalPaths(home: string | undefined): Promise<Set<string>> {
  try {
    return new Set(Object.keys((await loadGlobalState(globalStatePath(home))).artifacts).map((path) => resolve(path)));
  } catch {
    return new Set();
  }
}

/** Absolute paths recorded in the project's state, or none when Git or the state is unavailable. */
async function ownedProjectPaths(projectRoot: string): Promise<Set<string>> {
  try {
    const worktree = await gitWorktree(projectRoot);
    return new Set((await loadProjectState(projectStatePath(worktree))).paths.map((path) => resolve(worktree.root, path)));
  } catch {
    return new Set();
  }
}

export async function buildProjectPlan(projectStart = process.cwd(), machineConfigPath = MACHINE_CONFIG_PATH): Promise<BuiltPlan> {
  const { configPath, projectRoot, project, origin, machine } = await resolveProject(projectStart, machineConfigPath);
  const sourceRoot = machine?.source;
  const home = machine?.home;
  const context: PlannerContext = {
    mode: "project",
    sources: { sourceRoot, projectRoot },
    // A third-party repository has no shared layer: every input is personal.
    sharedSources: project.upstream === undefined ? { projectRoot, sharedOnly: true } : undefined,
    upstream: project.upstream,
    skipped: [],
    ownedPaths: await ownedProjectPaths(projectRoot),
    claudeMdExcludes: [],
    projectRoot,
    home,
    budgets: project.budgets,
    configuredHarnesses: HARNESS_NAMES.filter((harness) => project.scopes.some((scope) => (scope.harnesses ?? project.harnesses).includes(harness))),
    claudeImportAgentsMd: project.claudeImportAgentsMd,
    diagnostics: [],
    writes: [],
    explanations: [],
    skillPlacements: [],
    slotTargets: [],
    unmanagedSkills: [],
    instructionSizes: [],
  };
  await planScopes(
    context,
    project.scopes.map((scope) => toScope(scope, project)),
  );
  const plan = builtPlan(context, configPath);
  plan.origin = origin;
  if (project.upstream !== undefined) {
    plan.upstream = project.upstream;
    // The repository's own ignores cannot be edited, so generated skills and a personal configuration are excluded.
    plan.personalExcludes = [
      ...new Set(context.writes.flatMap((write) => (write.skillDirectory === undefined ? [] : [resolve(write.skillDirectory)]))),
      ...(origin === "project" ? [projectSourceRoot(projectRoot)] : []),
    ];
  }
  return plan;
}

export function assertPlanValid(plan: GenerationPlan, warningsAsErrors = false): void {
  const errors = plan.diagnostics.filter((item) => item.severity === "error" || (warningsAsErrors && item.severity === "warning"));
  if (errors.length > 0) {
    throw new Error(errors.map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`).join("\n"));
  }
}
