import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  loadMachineConfig,
  loadProjectConfig,
  MACHINE_CONFIG_PATH,
  PROJECT_CONFIG_RELATIVE_PATH,
  PROJECT_SOURCE_RELATIVE_PATH,
  parseSourceId,
  projectConfigPath,
  resolveConfiguredPath,
} from "./config.ts";
import { AgentsmithError, classify, errorMessage } from "./errors.ts";
import { CommandError, gitHasTracked, gitWorktree, runCommand } from "./git.ts";
import { getHarnessAdapter } from "./harness.ts";
import { mapIncludes } from "./markdown.ts";
import { atomicWrite } from "./safety.ts";
import { loadTemplate, resolvePartial, type SourceContext } from "./source.ts";
import { HARNESS_NAMES, type HarnessName } from "./types.ts";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface ProjectInitOptions {
  project?: string;
  prepare?: boolean;
  /** A template family to copy from the Source Repository into the project. */
  template?: string;
}

/** The command agentsmith adds to `scripts.prepare`; the project's installed, pinned `asmith` runs it. */
export const PREPARE_COMMAND = "asmith project generate";

const PERSONAL_SNIPPETS = "/.config/agentsmith/**/*.local.md";

/** Harnesses whose own directories already exist at the repository root, or all of them when none does. */
export function detectHarnesses(root: string): HarnessName[] {
  const markers: Record<HarnessName, string> = { generic: ".agents", codex: ".codex", claude: ".claude" };
  const found = HARNESS_NAMES.filter((harness) => existsSync(join(root, markers[harness])) && lstatSync(join(root, markers[harness])).isDirectory());
  return found.length > 0 ? found : [...HARNESS_NAMES];
}

const TEMPLATE_COMMENT = ["# A template family in .config/agentsmith/templates/<name>/ writes the shared AGENTS.md and CLAUDE.md.", '# template = "project"'];

/** The starter configuration; `template` is a project-owned Source ID for the root scope. */
export function projectConfigContent(harnesses: readonly HarnessName[], template?: string): string {
  return [
    "# agentsmith project configuration: https://niieani.github.io/agentsmith/reference/configuration#project-config",
    `harnesses = [${harnesses.map((harness) => JSON.stringify(harness)).join(", ")}]`,
    "",
    "[[scopes]]",
    'path = "."',
    ...(template === undefined ? TEMPLATE_COMMENT : [`template = ${JSON.stringify(template)}`]),
    "packs = []",
    "",
  ].join("\n");
}

/** A file `project init --template` copies into the project. */
export interface VendoredFile {
  /** The file in the Source Repository. */
  from: string;
  /** Its destination under the project's `.config/agentsmith/`. */
  to: string;
  content: string;
}

export interface VendoredTemplate {
  /** The project-owned Source ID of the copy, `project:<name>`. */
  sourceId: string;
  files: VendoredFile[];
}

/** Turn a Source Repository reference into its project-owned twin; the copy then never depends on the Source Repository. */
function projectOwned(sourceId: string): string {
  const id = parseSourceId(sourceId);
  return id.owner === "source" ? `project:${id.name}` : sourceId;
}

/**
 * Plan copying a template family from the Source Repository into the project: every file of
 * `templates/<name>/` (each harness variant and `default.md`), and every partial they include, transitively, that the
 * project does not provide itself. Includes of `source:<name>` are rewritten to `project:<name>`, so the shared layer
 * renders the copy. Writes nothing.
 */
export async function planTemplateCopy(sourceRoot: string, projectRoot: string, template: string): Promise<VendoredTemplate> {
  const id = parseSourceId(template);
  if (id.owner === "project") {
    throw new AgentsmithError("config", `--template ${template} already names a project template; give the Source Repository template's name`);
  }
  const context: SourceContext = { sourceRoot, projectRoot };
  const source = await classify("config", () => loadTemplate({ sourceRoot }, `source:${id.name}`, [...HARNESS_NAMES]));
  const templateDirectory = dirname(source.path);
  const projectSource = join(projectRoot, PROJECT_SOURCE_RELATIVE_PATH);
  const files: VendoredFile[] = [];
  const pending: string[] = [];
  const copy = async (from: string, to: string) => {
    if (files.some((file) => file.to === to)) return;
    const content = mapIncludes(await readFile(from, "utf8"), (include) => {
      pending.push(include);
      return projectOwned(include);
    });
    files.push({ from, to, content });
  };
  for (const entry of readdirSync(templateDirectory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isSymbolicLink()) throw new AgentsmithError("config", `Template files must not be symlinks: ${join(templateDirectory, entry.name)}`);
    if (entry.isFile()) await copy(join(templateDirectory, entry.name), join(projectSource, "templates", ...id.name.split("/"), entry.name));
  }
  const seen = new Set<string>();
  for (let include = pending.shift(); include !== undefined; include = pending.shift()) {
    const includeId = parseSourceId(include);
    const key = `${includeId.owner ?? ""}:${includeId.name}`;
    if (includeId.owner === "project" || seen.has(key)) continue;
    seen.add(key);
    // Resolve the way generation does: the project's own partial wins over the Source Repository's.
    const resolved = await classify("config", () =>
      resolvePartial(includeId.owner === "source" ? { sourceRoot } : context, include).catch((cause: unknown) => {
        throw new AgentsmithError("config", `template ${id.name} includes ${include}, which cannot be copied: ${errorMessage(cause)}`);
      }),
    );
    if (!resolved.path.startsWith(`${resolve(sourceRoot)}${sep}`)) continue;
    await copy(resolved.path, join(projectSource, "partials", ...includeId.name.split("/")));
  }
  return { sourceId: `project:${id.name}`, files };
}

/**
 * The files of a planned template copy that the project does not have yet. A destination that already holds the same
 * content is left alone, so rerunning is safe; any other existing file is an error.
 */
export async function missingTemplateFiles(plan: VendoredTemplate, root: string): Promise<VendoredFile[]> {
  const conflicts: string[] = [];
  const missing: VendoredFile[] = [];
  for (const file of plan.files) {
    if (!existsSync(file.to)) missing.push(file);
    else if (!lstatSync(file.to).isFile() || (await readFile(file.to, "utf8")) !== file.content) conflicts.push(file.to);
  }
  if (conflicts.length > 0) {
    throw new AgentsmithError(
      "config",
      [
        "project init --template never overwrites project files, and these differ from the copy it would write:",
        ...conflicts.map((path) => `  ${relative(root, path).split(sep).join("/")}`),
        "Nothing was changed. Move them away to copy the template again, or keep editing the project copy.",
      ].join("\n"),
    );
  }
  return missing;
}

/** Template families in a Source Repository, by name. */
function sourceTemplates(sourceRoot: string): string[] {
  const root = join(sourceRoot, "templates");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Point an existing project configuration at the template copy: unless some scope already names it, a root scope
 * without a template gets `template = "project:<name>"`, inserted as text so comments and layout stay. Returns "kept",
 * changing nothing, when the root scope has another template or the file cannot be edited safely.
 */
async function useTemplateCopy(configPath: string, sourceId: string): Promise<"set" | "already" | "kept"> {
  const name = parseSourceId(sourceId).name;
  const scopes = loadProjectConfig(configPath).scopes;
  if (scopes.some((scope) => scope.template === sourceId || scope.template === name)) return "already";
  const root = scopes.find((scope) => scope.path === ".");
  if (root === undefined || root.template !== undefined) return "kept";
  const before = await readFile(configPath, "utf8");
  const line = `template = ${JSON.stringify(sourceId)}`;
  let after: string | undefined;
  const comment = TEMPLATE_COMMENT.join("\n");
  if (before.includes(comment)) after = before.replace(comment, line);
  else {
    const lines = before.split("\n");
    const index = lines.findIndex((text) => /^\s*path\s*=\s*(["'])\.\1\s*(#.*)?$/.test(text));
    if (index !== -1) after = [...lines.slice(0, index + 1), line, ...lines.slice(index + 1)].join("\n");
  }
  if (after === undefined) return "kept";
  await atomicWrite(configPath, new TextEncoder().encode(after));
  try {
    if (loadProjectConfig(configPath).scopes.find((scope) => scope.path === ".")?.template === sourceId) return "set";
  } catch {
    // Fall through and restore the file as it was.
  }
  await atomicWrite(configPath, new TextEncoder().encode(before));
  return "kept";
}

/** `.gitignore` lines for generated skills (keeping a placeholder so the folder exists) and personal snippets. */
export function ignoreEntries(harnesses: readonly HarnessName[]): string[] {
  const roots = [...new Set(harnesses.map((harness) => getHarnessAdapter(harness).projectSkillDirectory.replaceAll("\\", "/")))];
  return [...roots.flatMap((root) => [`/${root}/*`, `!/${root}/.gitkeep`]), PERSONAL_SNIPPETS];
}

/** Append missing lines to `.gitignore` under one comment; returns the lines added. */
async function ensureGitignore(root: string, entries: readonly string[]): Promise<string[]> {
  const path = join(root, ".gitignore");
  const before = existsSync(path) ? await readFile(path, "utf8") : "";
  const present = new Set(before.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return [];
  const separator = before === "" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(path, `${before}${separator}# agentsmith: generated skills and personal snippets\n${missing.join("\n")}\n`);
  return missing;
}

export function detectPackageManager(root: string, packageJson: Record<string, unknown>): PackageManager {
  const field = typeof packageJson.packageManager === "string" ? packageJson.packageManager.split("@")[0] : undefined;
  if (field === "bun" || field === "pnpm" || field === "yarn" || field === "npm") return field;
  const lockfiles: Array<[string, PackageManager]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  return lockfiles.find(([file]) => existsSync(join(root, file)))?.[1] ?? "npm";
}

/** How to run `asmith` with a package manager: the installed dev dependency, or a one-off download. */
export function runAsmith(manager: PackageManager, installed: boolean): string {
  if (installed) return { bun: "bunx asmith", pnpm: "pnpm exec asmith", yarn: "yarn asmith", npm: "npx asmith" }[manager];
  return { bun: "bunx asmith", pnpm: "pnpm dlx asmith", yarn: "yarn dlx asmith", npm: "npx asmith" }[manager];
}

export function addDevDependency(manager: PackageManager): string[] {
  return {
    bun: ["bun", "add", "-d", "asmith"],
    pnpm: ["pnpm", "add", "-D", "asmith"],
    yarn: ["yarn", "add", "-D", "asmith"],
    npm: ["npm", "install", "-D", "asmith"],
  }[manager];
}

function indentOf(text: string): string | number {
  return /^[{[]\r?\n([ \t]+)\S/.exec(text)?.[1] ?? 2;
}

async function readPackageJson(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
  const text = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AgentsmithError("config", `${path} is not valid JSON: ${errorMessage(cause)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentsmithError("config", `${path} must hold a JSON object`);
  return { text, value: value as Record<string, unknown> };
}

function hasDependency(value: Record<string, unknown>): boolean {
  return ["devDependencies", "dependencies"].some((key) => {
    const table = value[key];
    return table !== null && typeof table === "object" && "asmith" in table;
  });
}

/**
 * Add `asmith` as a dev dependency with the project's package manager and run `asmith project generate` from
 * `scripts.prepare`, so every install regenerates the project's skills and personal files. A foreign `prepare` script is
 * kept as is, with a warning showing the chained command.
 */
async function prepare(root: string): Promise<PackageManager> {
  const path = join(root, "package.json");
  if (!existsSync(path)) throw new AgentsmithError("config", `--prepare needs a package.json in ${root}`);
  let { value } = await readPackageJson(path);
  const manager = detectPackageManager(root, value);
  if (hasDependency(value)) console.log("asmith is already a dependency.");
  else {
    const command = addDevDependency(manager);
    console.log(`Running ${command.join(" ")}`);
    try {
      await runCommand(command[0]!, command.slice(1), { cwd: root });
    } catch (cause) {
      const detail = cause instanceof CommandError ? cause.result.stderr.trim() || cause.result.stdout.trim() : errorMessage(cause);
      throw new AgentsmithError("failure", `${command.join(" ")} failed: ${detail}`);
    }
  }
  const current = await readPackageJson(path);
  value = current.value;
  const scripts = (value.scripts !== null && typeof value.scripts === "object" && !Array.isArray(value.scripts) ? value.scripts : {}) as Record<
    string,
    unknown
  >;
  const existing = scripts.prepare;
  if (typeof existing === "string" && existing.includes(PREPARE_COMMAND)) {
    console.log(`scripts.prepare already runs ${PREPARE_COMMAND}.`);
  } else if (existing !== undefined) {
    console.error(
      `WARNING prepare-script-kept: package.json already has a prepare script, left unchanged. To regenerate on install, change it to:\n  "prepare": ${JSON.stringify(`${String(existing)} && ${PREPARE_COMMAND}`)}`,
    );
  } else {
    value.scripts = { ...scripts, prepare: PREPARE_COMMAND };
    const newline = current.text.endsWith("\n") ? "\n" : "";
    await atomicWrite(path, new TextEncoder().encode(`${JSON.stringify(value, null, indentOf(current.text))}${newline}`));
    console.log(`Set scripts.prepare to ${JSON.stringify(PREPARE_COMMAND)}.`);
  }
  return manager;
}

/**
 * Set up agentsmith in the current repository: a starter project configuration with harnesses detected from existing
 * `.agents/`, `.codex/`, and `.claude/` directories, `.gitignore` entries for generated skills and personal snippets,
 * placeholder files that keep each skill root, with `--template` a copy of a Source Repository template, and with
 * `--prepare` a dev dependency and `prepare` script. Safe to rerun.
 */
export async function projectInit(options: ProjectInitOptions): Promise<void> {
  const start = resolve(options.project ?? process.cwd());
  const worktree = await classify("config", () => gitWorktree(start)).catch((cause: unknown) => {
    throw new AgentsmithError("config", `project init needs a Git repository: ${errorMessage(cause)}`);
  });
  const root = worktree.root;
  const configPath = projectConfigPath(root);
  const machinePath = resolveConfiguredPath(MACHINE_CONFIG_PATH, join(process.cwd(), "config.toml"));
  let sourceRoot: string | undefined;
  try {
    sourceRoot = existsSync(machinePath) ? loadMachineConfig(machinePath).source : undefined;
  } catch (cause) {
    // Only --template needs the machine config; without it, the hint below is skipped.
    if (options.template !== undefined) throw new AgentsmithError("config", errorMessage(cause));
  }

  // Plan the template copy first, so a conflict or a missing template leaves the repository untouched.
  let copy: VendoredTemplate | undefined;
  let missing: VendoredFile[] = [];
  if (options.template !== undefined) {
    if (sourceRoot === undefined) {
      throw new AgentsmithError("config", `--template copies from your Source Repository, but there is no machine config at ${machinePath}`);
    }
    copy = await planTemplateCopy(sourceRoot, root, options.template);
    missing = await missingTemplateFiles(copy, root);
  }

  let harnesses: HarnessName[];
  if (existsSync(configPath)) {
    if (copy === undefined) console.log(`${PROJECT_CONFIG_RELATIVE_PATH} already exists; left unchanged.`);
    harnesses = await classify("config", () => loadProjectConfig(configPath).harnesses);
  } else {
    harnesses = detectHarnesses(root);
    await mkdir(join(root, ".config", "agentsmith"), { recursive: true });
    await writeFile(configPath, projectConfigContent(harnesses, copy?.sourceId));
    console.log(`Wrote ${PROJECT_CONFIG_RELATIVE_PATH} for ${harnesses.join(", ")}.`);
  }

  if (copy !== undefined) {
    for (const file of missing) {
      await mkdir(dirname(file.to), { recursive: true });
      await writeFile(file.to, file.content);
    }
    if (missing.length > 0)
      console.log(`Copied from the Source Repository:\n${missing.map((file) => `  ${relative(root, file.to).split(sep).join("/")}`).join("\n")}`);
    else console.log(`The project already has ${copy.sourceId}; nothing copied.`);
    const used = await classify("config", () => useTemplateCopy(configPath, copy.sourceId));
    if (used === "set") console.log(`Set template = ${JSON.stringify(copy.sourceId)} for scope "." in ${PROJECT_CONFIG_RELATIVE_PATH}.`);
    if (used === "kept") {
      console.log(
        `${PROJECT_CONFIG_RELATIVE_PATH} was left unchanged, since scope "." already has a template. To use the copy, set template = ${JSON.stringify(copy.sourceId)} in the [[scopes]] entry that needs it.`,
      );
    }
  } else if (sourceRoot !== undefined) {
    const available = sourceTemplates(sourceRoot);
    const current = await classify("config", () => loadProjectConfig(configPath).scopes.find((scope) => scope.path === ".")?.template);
    const projectHasIt =
      current !== undefined &&
      parseSourceId(current).owner !== "source" &&
      existsSync(join(root, PROJECT_SOURCE_RELATIVE_PATH, "templates", parseSourceId(current).name));
    if (available.length > 0 && !projectHasIt) {
      console.log(
        `Templates in your Source Repository are personal, so the committed AGENTS.md does not use them. To commit one with the project, run:\n  asmith project init --template <name>   (available: ${available.join(", ")})`,
      );
    }
  }

  const added = await ensureGitignore(root, ignoreEntries(harnesses));
  if (added.length > 0) console.log(`Added to .gitignore:\n${added.map((line) => `  ${line}`).join("\n")}`);
  for (const harness of harnesses) {
    const skillRoot = join(root, getHarnessAdapter(harness).projectSkillDirectory);
    const placeholder = join(skillRoot, ".gitkeep");
    if (!existsSync(placeholder)) {
      await mkdir(skillRoot, { recursive: true });
      await writeFile(placeholder, "");
      console.log(`Created ${placeholder.slice(root.length + 1)} so the skill folder exists when a session starts.`);
    }
    for (const entry of await gitTrackedSkills(root, skillRoot)) {
      console.error(`WARNING committed-skill: ${entry} is committed; it stays tracked, but a generated skill with its name is an error.`);
    }
  }

  const manager = options.prepare ? await prepare(root) : undefined;
  const run = manager === undefined ? "asmith" : runAsmith(manager, true);
  console.log(
    [
      "",
      "Next:",
      `  1. Add templates, packs, and skills under .config/agentsmith/, then run ${run} project generate.`,
      "  2. Commit .config/agentsmith/, .gitignore, the .gitkeep placeholders, and the generated AGENTS.md and CLAUDE.md.",
    ].join("\n"),
  );
}

/** Skill directories Git tracks inside a skill root, other than the placeholder. */
async function gitTrackedSkills(root: string, skillRoot: string): Promise<string[]> {
  if (!(await gitHasTracked(root, skillRoot))) return [];
  const prefix = `${relative(root, skillRoot).split(sep).join("/")}/`;
  const result = await runCommand("git", ["ls-files", "-z", "--", skillRoot], { cwd: root });
  const names = new Set(
    result.stdout
      .split("\0")
      .filter((path) => path.startsWith(prefix) && path.slice(prefix.length).includes("/"))
      .map((path) => `${prefix}${path.slice(prefix.length).split("/")[0]}`),
  );
  return [...names].sort();
}
