import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";

import {
  HARNESS_NAMES,
  type Budgets,
  type HarnessName,
  type MachineConfig,
  type PackConfig,
  type ProfileConfig,
  type ProjectConfig,
  type RootConfig,
  type ScopeConfig,
  type SourceId,
} from "./types.ts";

export const MACHINE_CONFIG_PATH = "~/.agents/agentsmith/config.toml";
export const PROJECT_CONFIG_RELATIVE_PATH = ".config/agentsmith/config.toml";
export const PROJECT_SOURCE_RELATIVE_PATH = ".config/agentsmith";
export const GLOBAL_STATE_PATH = "~/.agents/agentsmith/state.toml";

type TomlTable = Record<string, unknown>;
export type SourceKind = "template" | "pack" | "skill" | "partial";

export class ConfigError extends Error {
  readonly configPath?: string;

  constructor(message: string, configPath?: string, options?: ErrorOptions) {
    super(configPath === undefined ? message : `${configPath}: ${message}`, options);
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}

function fail(message: string, path?: string): never {
  throw new ConfigError(message, path);
}

function table(value: unknown, label: string, path: string): TomlTable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a TOML table`, path);
  }
  return value as TomlTable;
}

function exactKeys(value: TomlTable, allowed: readonly string[], label: string, path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(`unknown ${label} key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, path);
}

function string(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`, path);
  return value;
}

function stringList(value: unknown, label: string, path: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`${label} must be an array of nonempty strings`, path);
  }
  return value as string[];
}

function unique(values: string[], label: string, path: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} contains duplicate value ${JSON.stringify(value)}`, path);
    seen.add(value);
  }
  return values;
}

function sourceIds(value: unknown, label: string, path: string): string[] {
  const values = unique(stringList(value, label, path), label, path);
  for (const id of values) parseSourceId(id);
  return values;
}

function harnesses(value: unknown, label: string, path: string, required = true): HarnessName[] {
  const values = unique(stringList(value, label, path, required), label, path);
  if (required && values.length === 0) fail(`${label} must not be empty`, path);
  const allowed = new Set<string>(HARNESS_NAMES);
  for (const value of values) if (!allowed.has(value)) fail(`${label} contains unknown harness ${JSON.stringify(value)}`, path);
  return values as HarnessName[];
}

function budgets(value: unknown, path: string): Budgets {
  if (value === undefined) return {};
  const input = table(value, "budgets", path);
  exactKeys(input, ["instruction_layer_bytes", "effective_instruction_bytes", "skill_markdown_bytes"], "budgets", path);
  const positive = (key: string): number | undefined => {
    const item = input[key];
    if (item === undefined) return undefined;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      fail(`budgets.${key} must be a positive integer`, path);
    }
    return item;
  };
  return {
    instructionLayerBytes: positive("instruction_layer_bytes"),
    effectiveInstructionBytes: positive("effective_instruction_bytes"),
    skillMarkdownBytes: positive("skill_markdown_bytes"),
  };
}

function readToml(path: string): TomlTable {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError("cannot read configuration", path, { cause });
  }
  try {
    return table(parse(text), "document", path);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError("invalid TOML", path, { cause });
  }
}

export function resolveConfiguredPath(raw: string, configPath: string): string {
  if (raw.includes("\0")) fail("configured path contains NUL", configPath);
  let expanded = raw;
  if (raw === "~") expanded = homedir();
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) expanded = join(homedir(), raw.slice(2));
  // Other forms such as ~someone are literal relative paths; no shell expansion is performed.
  return normalize(isAbsolute(expanded) ? expanded : resolve(dirname(configPath), expanded));
}

export function parseSourceId(raw: string): SourceId {
  if (typeof raw !== "string" || raw.length === 0) fail("Source ID must be a nonempty string");
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || raw.startsWith("@")) {
    fail(`invalid Source ID ${JSON.stringify(raw)}`);
  }
  const colon = raw.indexOf(":");
  const qualifier = colon === -1 ? undefined : raw.slice(0, colon);
  if (qualifier !== undefined && qualifier !== "source" && qualifier !== "project") {
    fail(`invalid Source ID qualifier in ${JSON.stringify(raw)}`);
  }
  const owner = qualifier as SourceId["owner"];
  const name = colon === -1 ? raw : raw.slice(colon + 1);
  if (name.includes(":")) fail(`invalid Source ID ${JSON.stringify(raw)}`);
  const parts = name.split("/");
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`invalid Source ID ${JSON.stringify(raw)}`);
  }
  return { owner, name, raw };
}

export function projectSourceRoot(projectRoot: string): string {
  return join(projectRoot, PROJECT_SOURCE_RELATIVE_PATH);
}

export function sourceRootConfigPath(sourceRoot: string): string {
  return join(sourceRoot, "agentsmith.toml");
}

export function profileConfigPath(sourceRoot: string, name: string): string {
  const id = parseSourceId(name);
  if (id.owner !== undefined) fail("profile name cannot be ownership-qualified");
  return contained(sourceRoot, join(sourceRoot, "profiles", `${id.name}.toml`), "profile path");
}

export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);
}

function contained(root: string, candidate: string, label: string): string {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} escapes ${rootPath}`);
  return candidatePath;
}

export function loadMachineConfig(path: string): MachineConfig {
  const absolutePath = resolveConfiguredPath(path, join(resolve("."), ".agentsmith-cli-path"));
  const input = readToml(absolutePath);
  exactKeys(input, ["source", "profile"], "machine configuration", absolutePath);
  const profile = string(input.profile, "profile", absolutePath);
  if (parseSourceId(profile).owner !== undefined) fail("machine profile cannot be ownership-qualified", absolutePath);
  const source = resolveConfiguredPath(string(input.source, "source", absolutePath), absolutePath);
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail(`source is not an existing directory: ${source}`, absolutePath);
  if (lstatSync(source).isSymbolicLink()) fail(`source must not be a symlink: ${source}`, absolutePath);
  return {
    source,
    profile,
  };
}

export function loadRootConfig(sourceRoot: string): RootConfig {
  const path = sourceRootConfigPath(resolve(sourceRoot));
  const input = readToml(path);
  exactKeys(input, ["budgets"], "source root configuration", path);
  return { budgets: budgets(input.budgets, path) };
}

export function loadProfileConfig(sourceRoot: string, name: string): ProfileConfig {
  const path = profileConfigPath(resolve(sourceRoot), name);
  const input = readToml(path);
  exactKeys(input, ["harnesses", "template", "packs", "skills_enable", "skills_disable", "budgets"], "profile", path);
  const result: ProfileConfig = {
    harnesses: harnesses(input.harnesses, "harnesses", path),
    template: string(input.template, "template", path),
    packs: sourceIds(input.packs, "packs", path),
    skillsEnable: sourceIds(input.skills_enable, "skills_enable", path),
    skillsDisable: sourceIds(input.skills_disable, "skills_disable", path),
    budgets: budgets(input.budgets, path),
  };
  for (const sourceId of [result.template, ...result.packs, ...result.skillsEnable, ...result.skillsDisable]) {
    if (parseSourceId(sourceId).owner === "project") fail("global profiles cannot reference project-owned sources", path);
  }
  return result;
}

export function loadPackConfig(packDir: string): PackConfig {
  const path = join(resolve(packDir), "pack.toml");
  let manifest: ReturnType<typeof lstatSync>;
  try {
    manifest = lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { skills: [] };
    throw new ConfigError("cannot inspect pack manifest", path, { cause });
  }
  if (manifest.isSymbolicLink() || !manifest.isFile()) fail("pack manifest must be a regular non-symlink file", path);
  const input = readToml(path);
  exactKeys(input, ["skills"], "pack", path);
  return { skills: sourceIds(input.skills, "skills", path) };
}

function projectRootFromConfig(path: string): string {
  const absolute = resolve(path);
  const expectedTail = [".config", "agentsmith", "config.toml"];
  const pieces = absolute.split(sep);
  if (expectedTail.some((part, index) => pieces[pieces.length - expectedTail.length + index] !== part)) {
    fail(`project configuration must be named ${PROJECT_CONFIG_RELATIVE_PATH}`, absolute);
  }
  return dirname(dirname(dirname(absolute)));
}

function normalizeScopePath(raw: string, root: string, configPath: string): string {
  if (raw.includes("\0") || raw.includes("\\") || isAbsolute(raw)) fail(`scope path ${JSON.stringify(raw)} is not project-relative`, configPath);
  const target = contained(root, resolve(root, raw), `scope path ${JSON.stringify(raw)}`);
  if (!existsSync(target) || !lstatSync(target).isDirectory()) fail(`scope path ${JSON.stringify(raw)} is not an existing directory`, configPath);
  const canonicalRoot = realpathSync(root);
  const canonicalTarget = realpathSync(target);
  contained(canonicalRoot, canonicalTarget, `scope path ${JSON.stringify(raw)}`);
  const normalized = relative(resolve(root), target).split(sep).join("/");
  return normalized === "" ? "." : normalized;
}

function scope(value: unknown, index: number, projectHarnesses: HarnessName[], root: string, path: string): ScopeConfig {
  const input = table(value, `scopes[${index}]`, path);
  exactKeys(input, ["path", "template", "packs", "harnesses", "skills_enable", "skills_disable"], `scopes[${index}]`, path);
  const scopeHarnesses = input.harnesses === undefined ? undefined : harnesses(input.harnesses, `scopes[${index}].harnesses`, path);
  if (scopeHarnesses !== undefined) {
    const defaults = new Set(projectHarnesses);
    for (const harness of scopeHarnesses) if (!defaults.has(harness)) fail(`scopes[${index}].harnesses must be a subset of project harnesses`, path);
  }
  const template = input.template === undefined ? undefined : string(input.template, `scopes[${index}].template`, path);
  if (template !== undefined) parseSourceId(template);
  return {
    path: normalizeScopePath(string(input.path, `scopes[${index}].path`, path), root, path),
    template,
    packs: sourceIds(input.packs, `scopes[${index}].packs`, path),
    harnesses: scopeHarnesses,
    skillsEnable: sourceIds(input.skills_enable, `scopes[${index}].skills_enable`, path),
    skillsDisable: sourceIds(input.skills_disable, `scopes[${index}].skills_disable`, path),
  };
}

export function loadProjectConfig(path: string): ProjectConfig {
  const absolutePath = resolve(path);
  const root = projectRootFromConfig(absolutePath);
  const input = readToml(absolutePath);
  exactKeys(input, ["harnesses", "budgets", "scopes"], "project configuration", absolutePath);
  const projectHarnesses = harnesses(input.harnesses, "harnesses", absolutePath);
  if (!Array.isArray(input.scopes)) fail("scopes must be an array of tables", absolutePath);
  const scopes = input.scopes.map((value, index) => scope(value, index, projectHarnesses, root, absolutePath));
  const paths = new Set<string>();
  for (const item of scopes) {
    if (paths.has(item.path)) fail(`duplicate normalized scope path ${JSON.stringify(item.path)}`, absolutePath);
    paths.add(item.path);
  }
  if (!paths.has(".")) fail('project configuration must declare a Repository Scope with path "."', absolutePath);
  for (const child of scopes) {
    const childParts = child.path === "." ? [] : child.path.split("/");
    for (const ancestor of scopes) {
      if (ancestor === child) continue;
      const ancestorParts = ancestor.path === "." ? [] : ancestor.path.split("/");
      const isAncestor = ancestorParts.length < childParts.length && ancestorParts.every((part, index) => childParts[index] === part);
      if (!isAncestor) continue;
      const inherited = new Set(ancestor.packs);
      const repeated = child.packs.find((pack) => inherited.has(pack));
      if (repeated !== undefined) {
        fail(`scope ${JSON.stringify(child.path)} repeats inherited pack ${JSON.stringify(repeated)} from ${JSON.stringify(ancestor.path)}`, absolutePath);
      }
    }
  }
  return { harnesses: projectHarnesses, budgets: budgets(input.budgets, absolutePath), scopes };
}

export function discoverProjectConfig(start: string): string {
  let current = resolve(start);
  if (existsSync(current) && !lstatSync(current).isDirectory()) current = dirname(current);
  for (;;) {
    const candidate = projectConfigPath(current);
    if (existsSync(candidate)) {
      if (!lstatSync(candidate).isFile()) fail("project configuration is not a regular file", candidate);
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) fail(`no ${PROJECT_CONFIG_RELATIVE_PATH} found from ${resolve(start)}`);
    current = parent;
  }
}
