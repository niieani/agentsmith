import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalHome } from "./fs.ts";
import { getHarnessAdapter, scopeDirectory, skillReadRoots, type SkillLocation } from "./harness.ts";
import { frontMatterFields } from "./skills.ts";
import type { Diagnostic, DiagnosticSeverity, HarnessName } from "./types.ts";

/**
 * Built-in per-harness limits.
 *
 * Each harness has a table of limits (`HARNESS_LIMITS`) and a load model (`LOAD_MODELS`) saying which instruction
 * files it loads at a scope. The checks are generic over the limit `kind`; adding a harness's limits is data: a load
 * model entry and rows in the table. Every limit can be overridden in `[budgets.<harness>]` by its `key`.
 */

/** What a limit measures. */
export type LimitKind =
  /** Each instruction file the harness loads that agentsmith writes. */
  | "instruction-file"
  /** The deepest `@import` chain starting at an instruction file agentsmith writes. */
  | "import-depth"
  /** Every instruction file the harness loads at a scope, written by agentsmith or not. */
  | "instruction-chain"
  /** A skill's `name` as the harness reads it. */
  | "skill-name"
  /** A skill's description fields as the harness lists them. */
  | "skill-description"
  /** A skill's `SKILL.md`. */
  | "skill-file"
  /** Every skill the harness lists at a scope, global and project, written by agentsmith or not. */
  | "skill-listing";

export type LimitMeasure = "lines" | "characters" | "bytes" | "tokens" | "hops";

export interface HarnessLimit {
  /** `[budgets.<harness>]` key; also names the diagnostic code `<harness>-<key with dashes>`. */
  key: string;
  kind: LimitKind;
  measure: LimitMeasure;
  default: number;
  severity: DiagnosticSeverity;
  /** What one measured unit is, for messages and documentation, such as "CLAUDE.md or CLAUDE.local.md file". */
  unit: string;
  /** What the harness does past the limit. */
  consequence: string;
  /** The harness only recommends the limit. */
  recommended?: boolean;
  /** `instruction-file`: only files the harness loads on demand. */
  onDemandOnly?: boolean;
  /** `instruction-file`: measure the file together with every file it imports. */
  expandImports?: boolean;
  /** `skill-description`, `skill-listing`: front matter fields the harness lists, joined by a space. */
  fields?: readonly string[];
  /** `skill-listing`: the skill name counts toward the listing too. */
  includeName?: boolean;
  /** `instruction-chain`: global instruction files count toward the chain. */
  includeGlobal?: boolean;
  /** `tokens`: what is divided by four to estimate tokens. */
  tokenBasis?: "characters" | "bytes";
}

/** Files after generation: planned content over the filesystem, minus stale artifacts agentsmith will delete. */
export interface InstructionView {
  read(path: string): string | undefined;
  /** File names directly in a directory. */
  list(directory: string): string[];
  /** Whether agentsmith writes `path` in this plan. */
  planned(path: string): boolean;
  /** `CLAUDE.md` files excluded through `claudeMdExcludes`. */
  claudeMdExcludes: ReadonlySet<string>;
}

/** What a harness loads, as far as limits are concerned. */
export interface HarnessLoadModel {
  /** Instruction files the harness loads from one project directory, in load order. */
  projectInstructionFiles(directory: string, view: InstructionView): string[];
  /** Global instruction files the harness loads. */
  globalInstructionFiles(home: string | undefined, view: InstructionView): string[];
  /** Instruction files may `@import` other files. */
  imports: boolean;
  /**
   * Instruction files in a project scope below the repository root load on demand, assuming the harness starts at the
   * root.
   */
  nestedOnDemand: boolean;
}

const existing = (view: InstructionView, paths: string[]) => paths.filter((path) => view.read(path) !== undefined);

export const LOAD_MODELS: Partial<Record<HarnessName, HarnessLoadModel>> = {
  codex: {
    // In each directory the first of AGENTS.override.md and AGENTS.md that exists, even an empty override.
    projectInstructionFiles: (directory, view) => existing(view, [join(directory, "AGENTS.override.md"), join(directory, "AGENTS.md")]).slice(0, 1),
    globalInstructionFiles: (home, view) => {
      const directory = dirname(getHarnessAdapter("codex").globalInstruction(home)!);
      const override = join(directory, "AGENTS.override.md");
      return (view.read(override) ?? "").trim() !== "" ? [override] : existing(view, [join(directory, "AGENTS.md")]);
    },
    imports: false,
    nestedOnDemand: false,
  },
  claude: {
    projectInstructionFiles: (directory, view) =>
      existing(view, [join(directory, "CLAUDE.md"), join(directory, ".claude", "CLAUDE.md"), join(directory, "CLAUDE.local.md")]).filter(
        (path) => !view.claudeMdExcludes.has(path),
      ),
    globalInstructionFiles: (home, view) => existing(view, [getHarnessAdapter("claude").globalInstruction(home)!]),
    imports: true,
    nestedOnDemand: true,
  },
};

const CLAUDE = "Claude Code";

export const HARNESS_LIMITS: Partial<Record<HarnessName, readonly HarnessLimit[]>> = {
  claude: [
    {
      key: "instruction_file_lines",
      kind: "instruction-file",
      measure: "lines",
      default: 200,
      severity: "notice",
      recommended: true,
      expandImports: true,
      unit: "CLAUDE.md or CLAUDE.local.md file",
      consequence: `${CLAUDE} still loads all of it, but long files use more context and are followed less reliably`,
    },
    {
      key: "on_demand_file_chars",
      kind: "instruction-file",
      measure: "characters",
      default: 40_000,
      severity: "warning",
      onDemandOnly: true,
      expandImports: true,
      unit: "file loaded on demand (a nested CLAUDE.md, with a 200K-token context window)",
      consequence: `${CLAUDE} reads only the start of it when it loads the file on demand`,
    },
    {
      key: "instruction_file_bytes",
      kind: "instruction-file",
      measure: "bytes",
      default: 4 * 1024 * 1024,
      severity: "error",
      unit: "instruction file",
      consequence: `${CLAUDE} skips the file entirely`,
    },
    {
      key: "import_depth",
      kind: "import-depth",
      measure: "hops",
      default: 4,
      severity: "error",
      unit: "@import chain",
      consequence: `${CLAUDE} does not load imports past the limit`,
    },
    {
      key: "skill_description_chars",
      kind: "skill-description",
      measure: "characters",
      default: 1536,
      severity: "warning",
      fields: ["description", "when_to_use"],
      unit: "skill description and when_to_use",
      consequence: `${CLAUDE} truncates the text in its skill listing`,
    },
    {
      key: "skill_listing_tokens",
      kind: "skill-listing",
      measure: "tokens",
      tokenBasis: "characters",
      default: 2000,
      severity: "warning",
      fields: ["description", "when_to_use"],
      includeName: true,
      unit: "skill listing (about 1% of a 200K-token context window)",
      consequence: `${CLAUDE} shortens or leaves out skill descriptions, so some skills may not be chosen`,
    },
    {
      key: "skill_file_lines",
      kind: "skill-file",
      measure: "lines",
      default: 500,
      severity: "notice",
      recommended: true,
      unit: "SKILL.md",
      consequence: `${CLAUDE} loads it whole when the skill runs; move detail into supporting files it reads when needed`,
    },
  ],
  codex: [
    {
      key: "project_doc_bytes",
      kind: "instruction-chain",
      measure: "bytes",
      default: 32 * 1024,
      severity: "warning",
      unit: "project AGENTS.md chain (project_doc_max_bytes)",
      consequence: "Codex truncates the file that crosses the limit and skips every later file",
    },
    {
      key: "skill_name_chars",
      kind: "skill-name",
      measure: "characters",
      default: 64,
      severity: "error",
      unit: "skill name",
      consequence: "Codex fails to parse the skill and does not load it",
    },
    {
      key: "skill_description_chars",
      kind: "skill-description",
      measure: "characters",
      default: 1024,
      severity: "warning",
      fields: ["description"],
      unit: "skill description",
      consequence: "Codex truncates the description in its skill catalog",
    },
    {
      key: "skill_listing_chars",
      kind: "skill-listing",
      measure: "characters",
      default: 8000,
      severity: "warning",
      fields: ["description"],
      unit: "skill descriptions visible at one scope",
      consequence: "Codex drops descriptions from its skill catalog past the budget",
    },
  ],
};

const HARNESS_LABELS: Partial<Record<HarnessName, string>> = { claude: CLAUDE, codex: "Codex" };

/** The `[budgets.<harness>]` keys a harness accepts; empty when it has no built-in limits. */
export function limitKeys(harness: HarnessName): string[] {
  return (HARNESS_LIMITS[harness] ?? []).map((limit) => limit.key);
}

/** Per-harness limit overrides from `[budgets.<harness>]`. */
export type LimitOverrides = Partial<Record<HarnessName, Record<string, number>>>;

const encoder = new TextEncoder();

function lineCount(content: string): number {
  if (content === "") return 0;
  return content.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

function characters(content: string): number {
  let count = 0;
  for (const _ of content) count++;
  return count;
}

function measureTexts(limit: HarnessLimit, texts: readonly string[]): number {
  const sum = (count: (text: string) => number) => texts.reduce((total, text) => total + count(text), 0);
  switch (limit.measure) {
    case "lines":
      return sum(lineCount);
    case "characters":
      return sum(characters);
    case "bytes":
      return sum((text) => encoder.encode(text).byteLength);
    case "tokens":
      return Math.ceil(sum(limit.tokenBasis === "bytes" ? (text) => encoder.encode(text).byteLength : characters) / 4);
    case "hops":
      return 0;
  }
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

function amount(limit: HarnessLimit, value: number): string {
  if (limit.measure === "tokens") return `about ${number(value)} tokens (estimated at 4 ${limit.tokenBasis ?? "characters"} per token)`;
  if (limit.measure === "bytes" && value >= 1024 * 1024 && value % (1024 * 1024) === 0) return `${number(value / 1024 / 1024)} MiB`;
  return `${number(value)} ${value === 1 ? limit.measure.replace(/s$/, "") : limit.measure}`;
}

function limitText(limit: HarnessLimit, value: number): string {
  const text =
    limit.measure === "tokens"
      ? `${number(value)}-token (estimated)`
      : limit.measure === "bytes" && value >= 1024 * 1024 && value % (1024 * 1024) === 0
        ? `${number(value / 1024 / 1024)} MiB`
        : `${number(value)}-${limit.measure.replace(/s$/, "")}`;
  return `${limit.recommended ? "recommended " : ""}${text} limit`;
}

export interface LimitScope {
  /** `<global>` or a project scope path. */
  path: string;
  harnesses: readonly HarnessName[];
}

export interface LimitSkill {
  /** Absolute directory agentsmith writes the skill to. */
  destinationDir: string;
  name: string;
  /** Configured harnesses that read the skill's root. */
  harnesses: readonly HarnessName[];
  /** Rendered SKILL.md. */
  skillMd: string;
}

export interface LimitInput {
  mode: "global" | "project";
  projectRoot?: string;
  home?: string;
  scopes: readonly LimitScope[];
  /** Every planned write, resolved. */
  writes: ReadonlyArray<{ destination: string; content: Uint8Array; kind: string }>;
  skills: readonly LimitSkill[];
  /** Absolute paths agentsmith recorded writing; those not planned again are deleted as stale. */
  ownedPaths: ReadonlySet<string>;
  claudeMdExcludes: readonly string[];
  overrides?: LimitOverrides;
}

function createView(input: LimitInput): InstructionView {
  const decoder = new TextDecoder();
  const planned = new Map(input.writes.map((write) => [resolve(write.destination), write.content]));
  const cache = new Map<string, string | undefined>();
  const stale = (path: string) => input.ownedPaths.has(path) && !planned.has(path);
  return {
    read(path) {
      const key = resolve(path);
      if (cache.has(key)) return cache.get(key);
      let content: string | undefined;
      const write = planned.get(key);
      if (write !== undefined) content = decoder.decode(write);
      else if (!stale(key)) {
        try {
          content = statSync(key).isFile() ? readFileSync(key, "utf8") : undefined;
        } catch {
          content = undefined;
        }
      }
      cache.set(key, content);
      return content;
    },
    list(directory) {
      const key = resolve(directory);
      const names = new Set<string>();
      try {
        for (const entry of readdirSync(key, { withFileTypes: true })) if (entry.isFile() && !stale(join(key, entry.name))) names.add(entry.name);
      } catch {
        // missing directory
      }
      for (const path of planned.keys()) if (dirname(path) === key) names.add(basename(path));
      return [...names].sort();
    },
    planned: (path) => planned.has(resolve(path)),
    claudeMdExcludes: new Set(input.claudeMdExcludes.map((path) => resolve(path))),
  };
}

/** `@path` imports outside code fences and inline code spans. */
export function claudeImports(content: string): string[] {
  const imports: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      if (!fence) fence = { marker: run[0]!, length: run.length };
      else if (run[0] === fence.marker && run.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const prose = line.replace(/(`+)[\s\S]*?\1/g, " ");
    for (const match of prose.matchAll(/(?:^|\s)@([^\s`]+)/g)) imports.push(match[1]!);
  }
  return imports;
}

function resolveImport(from: string, target: string, home: string | undefined): string {
  if (target.startsWith("~/")) return resolve(home ?? canonicalHome(), target.slice(2));
  return isAbsolute(target) ? resolve(target) : resolve(dirname(from), target);
}

interface ImportGraph {
  /** Existing imported files within `maxDepth` hops, in discovery order, excluding the root. */
  files: string[];
  /** The longest acyclic chain of existing files, root first. */
  deepest: string[];
}

function importGraph(root: string, view: InstructionView, home: string | undefined, maxDepth: number): ImportGraph {
  const targets = (file: string) =>
    [...new Set(claudeImports(view.read(file) ?? "").map((target) => resolveImport(file, target, home)))].filter((path) => view.read(path) !== undefined);
  const files: string[] = [];
  const seen = new Set([root]);
  let frontier = [root];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier)
      for (const target of targets(file)) {
        if (seen.has(target)) continue;
        seen.add(target);
        files.push(target);
        next.push(target);
      }
    frontier = next;
  }
  let deepest = [root];
  const visit = (chain: string[]) => {
    if (chain.length > deepest.length) deepest = chain;
    // One hop past the limit is enough to report it; stop there so cycles and wide graphs stay cheap.
    if (chain.length > maxDepth + 1) return;
    for (const target of targets(chain.at(-1)!)) if (!chain.includes(target)) visit([...chain, target]);
  };
  visit([root]);
  return { files, deepest };
}

function directoriesTo(projectRoot: string, scopePath: string): string[] {
  const directories = [projectRoot];
  if (scopePath !== ".") for (const segment of scopePath.split("/")) directories.push(join(directories.at(-1) ?? projectRoot, segment));
  return directories;
}

interface ListedSkill {
  name: string;
  directory: string;
  fields: Record<string, string>;
}

function skillsOnDisk(root: string, input: LimitInput, plannedDirectories: ReadonlySet<string>): ListedSkill[] {
  if (!existsSync(root)) return [];
  const found: ListedSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }
  const owned = [...input.ownedPaths];
  for (const name of entries) {
    const directory = join(root, name);
    if (name.startsWith(".") || plannedDirectories.has(directory)) continue;
    // A skill agentsmith wrote earlier and no longer plans is deleted by this run.
    if (owned.some((path) => path.startsWith(`${directory}${sep}`))) continue;
    let content: string;
    try {
      content = readFileSync(join(directory, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fields = frontMatterFields(content);
    found.push({ name: fields.name ?? name, directory, fields });
  }
  return found;
}

/** Runs every built-in limit for the harnesses selected in `input.scopes`. */
export function checkHarnessLimits(input: LimitInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const view = createView(input);
  const reported = new Set<string>();
  const harnesses = [...new Set(input.scopes.flatMap((scope) => scope.harnesses))];
  const plannedSkillsByRoot = new Map<string, LimitSkill[]>();
  for (const skill of input.skills) {
    const root = dirname(resolve(skill.destinationDir));
    plannedSkillsByRoot.set(root, [...(plannedSkillsByRoot.get(root) ?? []), skill]);
  }
  const plannedDirectories = new Set(input.skills.map((skill) => resolve(skill.destinationDir)));

  for (const harness of harnesses) {
    const limits = HARNESS_LIMITS[harness] ?? [];
    if (limits.length === 0) continue;
    const label = HARNESS_LABELS[harness] ?? harness;
    const value = (limit: HarnessLimit) => input.overrides?.[harness]?.[limit.key] ?? limit.default;
    const report = (limit: HarnessLimit, identity: string, message: string, path?: string) => {
      const key = `${limit.key}\0${identity}`;
      if (reported.has(`${harness}\0${key}`)) return;
      reported.add(`${harness}\0${key}`);
      diagnostics.push({
        severity: limit.severity,
        code: `${harness}-${limit.key.replaceAll("_", "-")}`,
        message: `${label}: ${message} (budgets.${harness}.${limit.key})`,
        ...(path === undefined ? {} : { path }),
      });
    };
    const over = (limit: HarnessLimit, measured: number) => measured > value(limit);
    const model = LOAD_MODELS[harness];

    for (const scope of input.scopes) {
      if (!scope.harnesses.includes(harness)) continue;
      const scopeLabel = scope.path === "<global>" ? "the global scope" : `scope ${scope.path}`;

      if (model !== undefined) {
        const directories = input.mode === "project" ? directoriesTo(input.projectRoot!, scope.path) : [];
        const globalFiles = model.globalInstructionFiles(input.home, view);
        const scopeFiles = input.mode === "global" ? globalFiles : model.projectInstructionFiles(scopeDirectory(input.projectRoot!, scope.path), view);
        const onDemand = input.mode === "project" && model.nestedOnDemand && scope.path !== ".";
        const importLimit = limits.find((item) => item.kind === "import-depth");
        const importDepth = model.imports && importLimit !== undefined ? value(importLimit) : 0;

        for (const file of scopeFiles.filter((path) => view.planned(path))) {
          for (const limit of limits) {
            if (limit.kind === "instruction-file") {
              if (limit.onDemandOnly && !onDemand) continue;
              const imported = limit.expandImports && model.imports ? importGraph(file, view, input.home, importDepth).files : [];
              const measured = measureTexts(
                limit,
                [file, ...imported].map((path) => view.read(path) ?? ""),
              );
              if (!over(limit, measured)) continue;
              const including = imported.length > 0 ? ` including ${imported.length} imported file${imported.length === 1 ? "" : "s"}` : "";
              report(
                limit,
                file,
                `${file} is ${amount(limit, measured)}${including}, over the ${limitText(limit, value(limit))} for a ${limit.unit}; ${limit.consequence}`,
                file,
              );
            } else if (limit.kind === "import-depth" && model.imports) {
              const { deepest } = importGraph(file, view, input.home, value(limit));
              const hops = deepest.length - 1;
              if (!over(limit, hops)) continue;
              report(
                limit,
                file,
                `the @import chain from ${file} is ${hops} hops deep (${deepest.map((path) => basename(path)).join(" -> ")}), over the ${value(limit)}-hop limit; ${limit.consequence}, so ${deepest.at(value(limit) + 1)} is not loaded`,
                file,
              );
            }
          }
        }

        for (const limit of limits.filter((item) => item.kind === "instruction-chain")) {
          if (input.mode === "global" && !limit.includeGlobal) continue;
          const projectFiles = directories.flatMap((directory) => model.projectInstructionFiles(directory, view));
          const chain = [...(limit.includeGlobal ? globalFiles : []), ...projectFiles];
          const measured = measureTexts(
            limit,
            chain.map((path) => view.read(path) ?? ""),
          );
          if (!over(limit, measured)) continue;
          report(
            limit,
            scope.path,
            `the instruction files loaded at ${scopeLabel} (${chain.join(", ")}) are ${amount(limit, measured)}, over the ${limitText(limit, value(limit))} for the ${limit.unit}; ${limit.consequence}`,
            chain.at(-1),
          );
        }
      }

      for (const limit of limits.filter((item) => item.kind === "skill-listing")) {
        // Global roots, then the skill roots of every directory from the repository root to the scope.
        const roots = [...skillReadRoots(harness, { mode: "global", home: input.home })];
        if (input.mode === "project")
          for (const directory of directoriesTo(input.projectRoot!, scope.path)) {
            const location: SkillLocation = { mode: "project", projectRoot: directory, scopePath: "." };
            roots.push(...skillReadRoots(harness, location));
          }
        const listed: ListedSkill[] = [];
        for (const root of [...new Set(roots)]) {
          for (const skill of plannedSkillsByRoot.get(root) ?? [])
            listed.push({ name: skill.name, directory: skill.destinationDir, fields: frontMatterFields(skill.skillMd) });
          listed.push(...skillsOnDisk(root, input, plannedDirectories));
        }
        const descriptionLimit = limits.find((item) => item.kind === "skill-description");
        const entries = listed.map((skill) => {
          let text = (limit.fields ?? ["description"])
            .map((field) => skill.fields[field] ?? "")
            .filter((part) => part !== "")
            .join(" ");
          // Text a harness truncates per skill counts only up to that limit.
          if (descriptionLimit !== undefined) text = [...text].slice(0, value(descriptionLimit)).join("");
          return limit.includeName ? `${skill.name}: ${text}` : text;
        });
        const measured = measureTexts(limit, entries);
        if (!over(limit, measured)) continue;
        report(
          limit,
          scope.path,
          `the ${listed.length} skills listed at ${scopeLabel} are ${amount(limit, measured)}, over the ${limitText(limit, value(limit))} for the ${limit.unit}; ${limit.consequence}`,
        );
      }
    }

    for (const skill of input.skills) {
      if (!skill.harnesses.includes(harness)) continue;
      const fields = frontMatterFields(skill.skillMd);
      for (const limit of limits) {
        if (limit.kind === "skill-name") {
          const name = fields.name ?? skill.name;
          const measured = measureTexts(limit, [name]);
          if (over(limit, measured))
            report(
              limit,
              skill.destinationDir,
              `skill ${skill.name} at ${skill.destinationDir} has a name of ${amount(limit, measured)}, over the ${limitText(limit, value(limit))} for a ${limit.unit}; ${limit.consequence}`,
              skill.destinationDir,
            );
        } else if (limit.kind === "skill-description") {
          const text = (limit.fields ?? ["description"])
            .map((field) => fields[field] ?? "")
            .filter((part) => part !== "")
            .join(" ");
          const measured = measureTexts(limit, [text]);
          if (over(limit, measured))
            report(
              limit,
              skill.destinationDir,
              `skill ${skill.name} at ${skill.destinationDir} has a ${(limit.fields ?? ["description"]).join(" + ")} of ${amount(limit, measured)}, over the ${limitText(limit, value(limit))}; ${limit.consequence}`,
              join(skill.destinationDir, "SKILL.md"),
            );
        } else if (limit.kind === "skill-file") {
          const measured = measureTexts(limit, [skill.skillMd]);
          if (over(limit, measured))
            report(
              limit,
              skill.destinationDir,
              `${join(skill.destinationDir, "SKILL.md")} is ${amount(limit, measured)}, over the ${limitText(limit, value(limit))} for a ${limit.unit}; ${limit.consequence}`,
              join(skill.destinationDir, "SKILL.md"),
            );
        }
      }
    }
  }
  return diagnostics;
}
