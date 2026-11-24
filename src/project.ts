import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProjectConfig, loadMachineConfig, loadProfileConfig, loadProjectConfig, resolveConfiguredPath } from "./config.ts";
import { canonicalRoot } from "./fs.ts";
import { gitWorktree, runCommand } from "./git.ts";
import type { MachineConfig, ProfileProject, ProjectConfig } from "./types.ts";

/** The project a project command works on, from its own configuration or from a profile `[[projects]]` entry. */
export interface ResolvedProject {
  /** The project configuration file, or the profile file declaring the matching entry. */
  configPath: string;
  projectRoot: string;
  project: ProjectConfig;
  origin: "project" | "profile";
  /** The machine configuration, when one exists. */
  machine?: MachineConfig;
}

/**
 * A comparable `host/path` form of a Git remote: `git@github.com:acme/tool.git`, `ssh://git@github.com/acme/tool`, and
 * `https://github.com/acme/tool/` all become `github.com/acme/tool`. Local paths are canonicalized.
 */
export function remoteKey(url: string, base = process.cwd()): string {
  let value = url.trim().replace(/\/+$/, "");
  if (value.startsWith("file://")) value = fileURLToPath(value);
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(value);
  const scp = scheme ? undefined : /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(value);
  const hosted = scheme ?? scp;
  if (hosted) return `${hosted[1]!.toLowerCase()}/${hosted[2]!.replace(/\/+$/, "").replace(/\.git$/, "")}`;
  if (/^[^/.~][^/]*\.[^/]+\//.test(value)) return value.replace(/\.git$/, "").replace(/^([^/]+)/, (host) => host.toLowerCase());
  let path = resolveConfiguredPath(value, join(base, ".remote"));
  try {
    path = realpathSync(path);
  } catch {
    // A remote path that does not exist locally is compared as written.
  }
  return path.replace(/\.git$/, "");
}

async function remoteUrls(root: string): Promise<string[]> {
  const result = await runCommand("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: root, allowFailure: true });
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 2)[1])
    .filter((value): value is string => value !== undefined);
}

/** The first entry matching a repository root, by canonical path or by any remote URL. */
export function matchProfileProject(entries: readonly ProfileProject[], root: string, remotes: readonly string[]): ProfileProject | undefined {
  const keys = new Set(remotes.map((url) => remoteKey(url, root)));
  return entries.find((entry) => (entry.path !== undefined ? entry.path === root : keys.has(remoteKey(entry.remote!, dirname(entry.file)))));
}

/** A one-scope project configuration for a repository configured by a profile entry. */
export function profileProjectConfig(entry: ProfileProject, profileHarnesses: ProjectConfig["harnesses"]): ProjectConfig {
  return {
    harnesses: entry.harnesses ?? profileHarnesses,
    budgets: {},
    claudeImportAgentsMd: true,
    exclusive: false,
    exclusiveAllow: [],
    upstream: entry.upstream,
    scopes: [
      {
        path: ".",
        template: entry.template,
        packs: entry.packs,
        skillsEnable: entry.skillsEnable,
        skillsDisable: entry.skillsDisable,
        harnessSkills: {},
        exclusiveAllow: [],
      },
    ],
  };
}

/**
 * Find the project for `start`: the nearest `.config/agentsmith/config.toml`, or else, for a Git repository without
 * one, the active profile's first `[[projects]]` entry matching the repository root or one of its remotes.
 */
export async function resolveProject(start: string, machineConfigPath: string): Promise<ResolvedProject> {
  const machinePath = resolveConfiguredPath(machineConfigPath, join(process.cwd(), "config.toml"));
  const machine = existsSync(machinePath) ? loadMachineConfig(machinePath) : undefined;
  let configPath: string;
  try {
    configPath = discoverProjectConfig(start);
  } catch (cause) {
    if (machine === undefined) throw cause;
    const profile = loadProfileConfig(machine.source, machine.profile);
    if (profile.projects.length === 0) throw cause;
    const worktree = await gitWorktree(existsSync(start) ? start : process.cwd()).catch(() => undefined);
    if (worktree === undefined) throw cause;
    const root = canonicalRoot(worktree.root);
    const entry = matchProfileProject(profile.projects, root, await remoteUrls(root));
    if (entry === undefined) {
      throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)}, and no [[projects]] entry of profile ${JSON.stringify(machine.profile)} matches ${root}`,
      );
    }
    return { configPath: entry.file, projectRoot: root, project: profileProjectConfig(entry, profile.harnesses), origin: "profile", machine };
  }
  const projectRoot = canonicalRoot(dirname(dirname(dirname(configPath))));
  return { configPath, projectRoot, project: loadProjectConfig(configPath), origin: "project", machine };
}
