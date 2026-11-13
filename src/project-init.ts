import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { loadProjectConfig, PROJECT_CONFIG_RELATIVE_PATH, projectConfigPath } from "./config.ts";
import { AgentsmithError, classify, errorMessage } from "./errors.ts";
import { CommandError, gitHasTracked, gitWorktree, runCommand } from "./git.ts";
import { getHarnessAdapter } from "./harness.ts";
import { atomicWrite } from "./safety.ts";
import { HARNESS_NAMES, type HarnessName } from "./types.ts";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface ProjectInitOptions {
  project?: string;
  prepare?: boolean;
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

export function projectConfigContent(harnesses: readonly HarnessName[]): string {
  return [
    "# agentsmith project configuration: https://niieani.github.io/agentsmith/reference/configuration#project-config",
    `harnesses = [${harnesses.map((harness) => JSON.stringify(harness)).join(", ")}]`,
    "",
    "[[scopes]]",
    'path = "."',
    "# A template family in .config/agentsmith/templates/<name>/ writes the shared AGENTS.md and CLAUDE.md.",
    '# template = "project"',
    "packs = []",
    "",
  ].join("\n");
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
 * placeholder files that keep each skill root, and with `--prepare` a dev dependency and `prepare` script. Safe to rerun.
 */
export async function projectInit(options: ProjectInitOptions): Promise<void> {
  const start = resolve(options.project ?? process.cwd());
  const worktree = await classify("config", () => gitWorktree(start)).catch((cause: unknown) => {
    throw new AgentsmithError("config", `project init needs a Git repository: ${errorMessage(cause)}`);
  });
  const root = worktree.root;
  const configPath = projectConfigPath(root);
  let harnesses: HarnessName[];
  if (existsSync(configPath)) {
    console.log(`${PROJECT_CONFIG_RELATIVE_PATH} already exists; left unchanged.`);
    harnesses = await classify("config", () => loadProjectConfig(configPath).harnesses);
  } else {
    harnesses = detectHarnesses(root);
    await mkdir(join(root, ".config", "agentsmith"), { recursive: true });
    await writeFile(configPath, projectConfigContent(harnesses));
    console.log(`Wrote ${PROJECT_CONFIG_RELATIVE_PATH} for ${harnesses.join(", ")}.`);
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
