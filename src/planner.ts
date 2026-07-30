import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  discoverProjectConfig,
  loadMachineConfig,
  loadProfileConfig,
  loadProjectConfig,
  loadRootConfig,
  MACHINE_CONFIG_PATH,
  resolveConfiguredPath,
} from "./config.ts";
import { walkFiles } from "./fs.ts";
import { getHarnessAdapter } from "./harness.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  loadInstructionContributions,
  loadPack,
  loadSkill,
  loadSkillContributions,
  loadTemplate,
  resolvePartial,
  type LoadedPack,
  type SourceContext,
} from "./source.ts";
import { parseSkillIdentity, scanSkillRoot } from "./skills.ts";
import type { Budgets, Contribution, Diagnostic, GenerationPlan, HarnessName, PlannedWrite, ScopeConfig, SkillIdentity } from "./types.ts";

const encoder = new TextEncoder();

export interface BuiltPlan extends GenerationPlan {
  mode: "global" | "project";
  sourceRoot?: string;
  projectRoot?: string;
  configPath: string;
  plannedPaths: string[];
}

interface ScopeInput {
  path: string;
  template?: string;
  packs: string[];
  harnesses: HarnessName[];
  skillsEnable: string[];
  skillsDisable: string[];
}

interface SkillPlacement {
  harness: HarnessName;
  scope: string;
  name: string;
  sourceId: string;
  destinationDir: string;
}

interface PlannerContext {
  mode: "global" | "project";
  sources: SourceContext;
  projectRoot?: string;
  budgets: Budgets;
  diagnostics: Diagnostic[];
  writes: PlannedWrite[];
  explanations: unknown[];
  skillPlacements: SkillPlacement[];
  instructionSizes: Array<{ harness: HarnessName; scope: string; bytes: number }>;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function mergeBudgets(base: Budgets, override: Budgets): Budgets {
  return {
    instructionLayerBytes: override.instructionLayerBytes ?? base.instructionLayerBytes,
    effectiveInstructionBytes: override.effectiveInstructionBytes ?? base.effectiveInstructionBytes,
    skillMarkdownBytes: override.skillMarkdownBytes ?? base.skillMarkdownBytes,
  };
}

function warning(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
  diagnostics.push({ severity: "warning", code, message, path });
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

function toScope(input: ScopeConfig, defaults: HarnessName[]): ScopeInput {
  return {
    path: input.path,
    template: input.template,
    packs: input.packs,
    harnesses: input.harnesses ?? defaults,
    skillsEnable: input.skillsEnable,
    skillsDisable: input.skillsDisable,
  };
}

async function renderContent(context: PlannerContext, content: string, path: string, contributions: Contribution[]) {
  const rendered = await renderMarkdown({
    content,
    templatePath: path,
    contributions,
    resolveInclude: async (sourceId) => resolvePartial(context.sources, sourceId),
  });
  context.diagnostics.push(...rendered.diagnostics);
  return rendered;
}

async function enabledSkills(scope: ScopeInput, packs: LoadedPack[]): Promise<string[]> {
  const candidates = stableUnion([...packs.flatMap((pack) => pack.config.skills), ...scope.skillsEnable]);
  const disabled = new Set(scope.skillsDisable);
  return candidates.filter((sourceId) => !disabled.has(sourceId));
}

async function planInstruction(context: PlannerContext, scope: ScopeInput, harness: HarnessName, packs: LoadedPack[]): Promise<void> {
  const contributions = (await Promise.all(packs.map((pack) => loadInstructionContributions(pack, harness)))).flat();
  if (!scope.template) {
    if (contributions.length > 0) {
      warning(
        context.diagnostics,
        "instruction-contribution-inactive",
        `${contributions.length} instruction contribution(s) are inactive because scope ${scope.path} has no Instruction Layer for ${harness}`,
      );
    }
    return;
  }
  const template = await loadTemplate(context.sources, scope.template, harness);
  const rendered = await renderContent(context, template.content, template.path, contributions);
  const adapter = getHarnessAdapter(harness);
  const destination = context.mode === "global" ? adapter.globalInstruction() : adapter.projectInstruction(context.projectRoot!, scope.path);
  context.diagnostics.push(...(adapter.preflightInstruction?.(destination) ?? []));
  const bytes = utf8Bytes(rendered.content);
  context.instructionSizes.push({ harness, scope: scope.path, bytes });
  if (context.budgets.instructionLayerBytes && bytes > context.budgets.instructionLayerBytes) {
    warning(
      context.diagnostics,
      "instruction-layer-budget",
      `${destination} is ${bytes} bytes, exceeding the ${context.budgets.instructionLayerBytes}-byte instruction layer budget`,
      destination,
    );
  }
  context.writes.push({
    destination,
    content: encoder.encode(rendered.content),
    kind: "instruction",
    harness,
    scope: scope.path,
    provenance: [template.path, ...Object.values(rendered.trace.slots).flat(), ...rendered.trace.includes],
  });
  context.explanations.push({
    kind: "instruction",
    harness,
    scope: scope.path,
    destination,
    template: template.path,
    packs: scope.packs,
    trace: rendered.trace,
    bytes,
  });
}

async function planSkills(context: PlannerContext, scope: ScopeInput, harness: HarnessName, packs: LoadedPack[]): Promise<void> {
  const sourceIds = await enabledSkills(scope, packs);
  const enabledSet = new Set(sourceIds);
  const contributions = (await Promise.all(packs.map((pack) => loadSkillContributions(pack, harness)))).flat();
  const usedContributionPaths = new Set<string>();

  for (const sourceId of sourceIds) {
    const skill = await loadSkill(context.sources, sourceId);
    const skillDir = skill.sourceDir;
    const adapter = getHarnessAdapter(harness);
    const root = context.mode === "global" ? adapter.globalSkillRoot() : adapter.projectSkillRoot(context.projectRoot!, scope.path);
    const destinationDir = join(root, skill.name);
    context.skillPlacements.push({ harness, scope: scope.path, name: skill.name, sourceId, destinationDir });
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
      for (const contribution of contributions) {
        if (contribution.slot === slot) usedContributionPaths.add(contribution.path);
      }
    }
    let markdownBytes = 0;
    let supportBytes = 0;
    const fileExplanations: unknown[] = [];
    for (const file of files) {
      const destination = join(destinationDir, file.relativePath);
      if (file.relativePath.endsWith(".md")) {
        const fileContributions = contributions.filter((item) => slotsByFile.get(file.absolutePath)?.has(item.slot));
        const rendered = await renderContent(context, new TextDecoder().decode(file.content), file.absolutePath, fileContributions);
        const content = encoder.encode(rendered.content);
        if (file.relativePath === "SKILL.md") {
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
          harness,
          scope: scope.path,
          provenance: [file.absolutePath, ...Object.values(rendered.trace.slots).flat(), ...rendered.trace.includes],
        });
        fileExplanations.push({ path: file.relativePath, trace: rendered.trace, bytes: content.byteLength });
      } else {
        supportBytes += file.content.byteLength;
        context.writes.push({
          destination,
          content: file.content,
          mode: file.mode,
          kind: "skill",
          harness,
          scope: scope.path,
          provenance: [file.absolutePath],
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
      harness,
      scope: scope.path,
      sourceId,
      name: skill.name,
      destination: destinationDir,
      enabledBy: packs.filter((pack) => pack.config.skills.includes(sourceId)).map((pack) => pack.sourceId),
      explicitlyEnabled: scope.skillsEnable.includes(sourceId),
      scopeExclusions: scope.skillsDisable,
      markdownBytes,
      supportBytes,
      files: fileExplanations,
    });
  }

  for (const contribution of contributions) {
    if (usedContributionPaths.has(contribution.path)) continue;
    warning(
      context.diagnostics,
      "skill-contribution-inactive",
      `Pack ${contribution.pack} contributes to skill slot ${contribution.slot}, but no enabled skill declares that slot in scope ${scope.path} for ${harness}`,
      contribution.path,
    );
  }

  for (const excluded of scope.skillsDisable) {
    if (!enabledSet.has(excluded) && !packs.some((pack) => pack.config.skills.includes(excluded))) {
      warning(context.diagnostics, "skill-exclusion-inactive", `Scope ${scope.path} excludes ${excluded}, but that scope does not enable it`);
    }
  }
}

function validatePlannedSkillCollisions(context: PlannerContext): void {
  const placements = context.skillPlacements;
  for (let left = 0; left < placements.length; left++) {
    for (let right = left + 1; right < placements.length; right++) {
      const a = placements[left]!;
      const b = placements[right]!;
      if (a.harness !== b.harness || a.name !== b.name) continue;
      const sameChain = context.mode === "global" || isAncestorScope(a.scope, b.scope) || isAncestorScope(b.scope, a.scope);
      if (sameChain) {
        error(
          context.diagnostics,
          "skill-name-collision",
          `Skill ${a.name} is visible more than once for ${a.harness}: ${a.scope} (${a.sourceId}) and ${b.scope} (${b.sourceId})`,
        );
      }
    }
  }
}

async function validateUnmanagedSkillCollisions(context: PlannerContext, scopes: ScopeInput[]): Promise<void> {
  const plannedDirs = new Set(context.skillPlacements.map((item) => resolve(item.destinationDir)));
  const roots = new Map<string, { harness: HarnessName; scope: string }>();
  if (context.mode === "project") {
    for (const scope of scopes) {
      for (const harness of scope.harnesses) {
        const segments = scope.path === "." ? [] : scope.path.split("/");
        for (let index = 0; index <= segments.length; index++) {
          const ancestor = index === 0 ? "." : segments.slice(0, index).join("/");
          const root = getHarnessAdapter(harness).projectSkillRoot(context.projectRoot!, ancestor);
          roots.set(resolve(root), { harness, scope: ancestor });
        }
      }
    }
    for (const harness of stableUnion(scopes.flatMap((scope) => scope.harnesses)) as HarnessName[]) {
      for (const discovered of await discoverNativeSkillRoots(context.projectRoot!, harness)) {
        roots.set(resolve(discovered.root), { harness, scope: discovered.scope });
      }
    }
  }
  const configuredHarnesses = stableUnion(scopes.flatMap((scope) => scope.harnesses)) as HarnessName[];
  for (const harness of configuredHarnesses) {
    roots.set(resolve(getHarnessAdapter(harness).globalSkillRoot()), { harness, scope: "<global>" });
  }

  const unmanaged: Array<SkillIdentity & { harness: HarnessName; scope: string }> = [];
  for (const [root, metadata] of roots) {
    const scanned = await scanSkillRoot(root);
    context.diagnostics.push(...scanned.diagnostics);
    for (const skill of scanned.skills) {
      if (!plannedDirs.has(resolve(skill.sourceDir))) unmanaged.push({ ...skill, ...metadata });
    }
  }
  for (const planned of context.skillPlacements) {
    for (const external of unmanaged) {
      if (planned.harness !== external.harness || planned.name !== external.name) continue;
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
      if (a.harness !== b.harness || a.name !== b.name) continue;
      const visible = a.scope === "<global>" || b.scope === "<global>" || isAncestorScope(a.scope, b.scope) || isAncestorScope(b.scope, a.scope);
      if (visible)
        warning(context.diagnostics, "unmanaged-skill-collision", `Visible unmanaged skills share name ${a.name}: ${a.sourceDir} and ${b.sourceDir}`);
    }
  }
}

async function discoverNativeSkillRoots(projectRoot: string, harness: HarnessName): Promise<Array<{ root: string; scope: string }>> {
  const adapter = getHarnessAdapter(harness);
  const found: Array<{ root: string; scope: string }> = [];
  const excluded = new Set([".git", ".hg", ".svn", "node_modules"]);

  async function visit(directory: string): Promise<void> {
    const candidate = join(directory, adapter.projectSkillDirectory);
    if (existsSync(candidate)) {
      const scope = relative(projectRoot, directory).replaceAll("\\", "/") || ".";
      found.push({ root: candidate, scope });
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      if (entry.name === ".agents" || entry.name === ".claude") continue;
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
    if (item.harness === "codex" && context.mode === "project" && effective > 32 * 1024) {
      warning(
        context.diagnostics,
        "codex-default-instruction-cap",
        `Codex effective project instructions at ${item.scope} are ${effective} bytes, exceeding its configurable default 32 KiB cap`,
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

async function planScopes(context: PlannerContext, scopes: ScopeInput[]): Promise<void> {
  const sorted = [...scopes].sort((a, b) => scopeDepth(a.path) - scopeDepth(b.path) || (a.path < b.path ? -1 : 1));
  for (const scope of sorted) {
    const packs = scope.packs.map((sourceId) => loadPack(context.sources, sourceId));
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
    for (const harness of scope.harnesses) {
      await planInstruction(context, scope, harness, packs);
      await planSkills(context, scope, harness, packs);
    }
  }
  validatePlannedSkillCollisions(context);
  await validateUnmanagedSkillCollisions(context, sorted);
  validateEffectiveInstructionBudgets(context);
  coalesceWrites(context);
}

function builtPlan(context: PlannerContext, configPath: string): BuiltPlan {
  return {
    mode: context.mode,
    sourceRoot: context.sources.sourceRoot,
    projectRoot: context.projectRoot,
    configPath,
    writes: context.writes,
    deletes: [],
    diagnostics: context.diagnostics,
    explanation: {
      mode: context.mode,
      sourceRoot: context.sources.sourceRoot,
      projectRoot: context.projectRoot,
      artifacts: context.explanations,
      diagnostics: context.diagnostics,
    },
    plannedPaths: context.writes.filter((write) => write.kind !== "state").map((write) => write.destination),
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
    budgets: mergeBudgets(root.budgets, profile.budgets),
    diagnostics: [],
    writes: [],
    explanations: [],
    skillPlacements: [],
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
    },
  ]);
  return builtPlan(context, resolvedConfig);
}

export async function buildProjectPlan(projectStart = process.cwd(), machineConfigPath = MACHINE_CONFIG_PATH): Promise<BuiltPlan> {
  const configPath = discoverProjectConfig(projectStart);
  const projectRoot = dirname(dirname(dirname(configPath)));
  const project = loadProjectConfig(configPath);
  let sourceRoot: string | undefined;
  const resolvedMachine = resolveConfiguredPath(machineConfigPath, join(process.cwd(), "config.toml"));
  if (existsSync(resolvedMachine)) sourceRoot = loadMachineConfig(resolvedMachine).source;
  const context: PlannerContext = {
    mode: "project",
    sources: { sourceRoot, projectRoot },
    projectRoot,
    budgets: project.budgets,
    diagnostics: [],
    writes: [],
    explanations: [],
    skillPlacements: [],
    instructionSizes: [],
  };
  await planScopes(
    context,
    project.scopes.map((scope) => toScope(scope, project.harnesses)),
  );
  return builtPlan(context, configPath);
}

export function assertPlanValid(plan: GenerationPlan, warningsAsErrors = false): void {
  const errors = plan.diagnostics.filter((item) => item.severity === "error" || warningsAsErrors);
  if (errors.length > 0) {
    throw new Error(errors.map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`).join("\n"));
  }
}
