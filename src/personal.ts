import { readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { AgentsmithError } from "./errors.ts";
import { gitIsIgnored, runCommand } from "./git.ts";
import { atomicWrite } from "./safety.ts";

/**
 * Entries agentsmith keeps in files it shares with the user: lines in the repository's `info/exclude`, and paths in
 * `claudeMdExcludes` of `<project>/.claude/settings.local.json`. agentsmith owns only the entries it recorded in project
 * state and leaves every other line and key alone.
 */
export interface PersonalEntries {
  excludes: string[];
  claudeMdExcludes: string[];
}

/** The repository's `info/exclude`, shared by every worktree of the repository. */
export async function infoExcludePath(worktreeRoot: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktreeRoot });
  return resolve(worktreeRoot, result.stdout.trim());
}

export function claudeLocalSettingsPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "settings.local.json");
}

/** An anchored `info/exclude` pattern for one file or directory inside the worktree. */
export function excludeEntry(worktreeRoot: string, path: string, directory = false): string {
  return `/${relative(worktreeRoot, path).replaceAll("\\", "/")}${directory ? "/" : ""}`;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

/** The first line of agentsmith's block in `info/exclude`. */
export const EXCLUDE_BLOCK_START = "# BEGIN agentsmith: personal files, shared by every worktree. agentsmith adds lines here and never removes them.";
/** The last line of agentsmith's block in `info/exclude`. */
export const EXCLUDE_BLOCK_END = "# END agentsmith";

/** Lines of `info/exclude` that are not comments or blank. */
export async function readInfoExclude(path: string): Promise<string[]> {
  const text = (await readText(path)) ?? "";
  return text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("#"));
}

/**
 * Add missing `add` lines to agentsmith's block in `info/exclude`, creating the block at the end of the file when it does
 * not exist. A line already present anywhere in the file is not added again, and every other line stays as written.
 *
 * Entries are never removed: `info/exclude` is shared by every worktree of the repository, while project state is per
 * worktree, so removing a line one worktree no longer needs could make another worktree's personal file show up in Git.
 * Returns the lines added.
 */
export async function updateInfoExclude(path: string, add: readonly string[]): Promise<string[]> {
  const before = (await readText(path)) ?? "";
  const lines = before === "" ? [] : before.replace(/\r?\n$/, "").split(/\r?\n/);
  const present = new Set(lines);
  const missing = [...new Set(add)].filter((entry) => !present.has(entry));
  if (missing.length === 0) return [];
  const start = lines.indexOf(EXCLUDE_BLOCK_START);
  const end = start === -1 ? -1 : lines.indexOf(EXCLUDE_BLOCK_END, start + 1);
  if (start !== -1 && end !== -1) lines.splice(end, 0, ...missing);
  else lines.push(EXCLUDE_BLOCK_START, ...missing, EXCLUDE_BLOCK_END);
  await atomicWrite(path, new TextEncoder().encode(`${lines.join("\n")}\n`));
  return missing;
}

type JsonObject = Record<string, unknown>;

/** Parse a Claude settings file, or an empty object when it does not exist. Invalid JSON is a configuration error. */
export async function readClaudeSettings(path: string): Promise<JsonObject | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AgentsmithError(
      "config",
      `${path} is not valid JSON, so agentsmith cannot update claudeMdExcludes: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentsmithError("config", `${path} must hold a JSON object`);
  const excludes = (value as JsonObject).claudeMdExcludes;
  if (excludes !== undefined && (!Array.isArray(excludes) || excludes.some((item) => typeof item !== "string"))) {
    throw new AgentsmithError("config", `${path}: claudeMdExcludes must be an array of strings`);
  }
  return value as JsonObject;
}

/**
 * Add and remove `claudeMdExcludes` entries, preserving every other key and entry. An emptied list loses its key, and a
 * file left as `{}` is deleted, since it then configures nothing.
 */
export async function updateClaudeMdExcludes(path: string, add: readonly string[], remove: readonly string[]): Promise<void> {
  const existing = await readClaudeSettings(path);
  if (existing === undefined && add.length === 0) return;
  const settings: JsonObject = existing ?? {};
  const before = (settings.claudeMdExcludes as string[] | undefined) ?? [];
  const keep = new Set(add);
  const after = before.filter((entry) => !remove.includes(entry) || keep.has(entry));
  for (const entry of add) if (!after.includes(entry)) after.push(entry);
  if (existing !== undefined && after.length === before.length && after.every((entry, index) => entry === before[index])) return;
  if (after.length > 0) settings.claudeMdExcludes = after;
  else delete settings.claudeMdExcludes;
  if (Object.keys(settings).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`));
}

/**
 * The `info/exclude` lines a project needs: every personal file, and the Claude local settings file while agentsmith
 * keeps entries there and Git would otherwise show it. An entry `info/exclude` already has is kept, since that entry is
 * what makes Git ignore the file now.
 */
export async function desiredExcludes(
  worktreeRoot: string,
  projectRoot: string,
  personalPaths: readonly string[],
  claudeMdExcludes: readonly string[],
  present: readonly string[],
): Promise<string[]> {
  const entries = personalPaths.map((path) => excludeEntry(worktreeRoot, path));
  if (claudeMdExcludes.length > 0) {
    const settings = claudeLocalSettingsPath(projectRoot);
    const entry = excludeEntry(worktreeRoot, settings);
    if (present.includes(entry) || !(await gitIsIgnored(worktreeRoot, settings))) entries.push(entry);
  }
  return [...new Set(entries)];
}
