import { lstat, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { discoverProjectConfig, loadProjectConfig, MACHINE_CONFIG_PATH, requireMachineHome, resolveConfiguredPath } from "./config.ts";
import { AgentsmithError, classify, errorMessage } from "./errors.ts";
import { agentsmithHome, canonicalRoot, isWithin } from "./fs.ts";
import { gitPathStatus, gitWorktree } from "./git.ts";
import { buildProjectPlan } from "./planner.ts";
import {
  type ArtifactBackup,
  backupGlobalArtifacts,
  globalBackupRoot,
  globalBlobDirectory,
  globalStatePath,
  hashBytes,
  loadGlobalState,
  loadProjectState,
  projectBackupRoot,
  projectStatePath,
  quarantinePaths,
  saveProjectState,
} from "./safety.ts";
import { globalStatusPath } from "./status.ts";

export interface CleanOptions {
  config?: string;
  project?: string;
  scope?: string;
  /** Delete; without it, clean only reports. */
  yes?: boolean;
  force?: boolean;
  onModified?: "fail" | "backup";
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove now-empty directories from each removed path's parent up to, but excluding, `stop`. */
async function pruneEmptyParents(paths: readonly string[], stop: string): Promise<string[]> {
  const removed: string[] = [];
  const boundary = resolve(stop);
  for (const path of [...paths].sort().reverse()) {
    let current = dirname(resolve(path));
    while (current !== boundary && isWithin(boundary, current)) {
      try {
        await rmdir(current);
        removed.push(current);
      } catch (cause) {
        const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
        if (code !== "ENOENT") break;
      }
      current = dirname(current);
    }
  }
  return removed;
}

interface CleanPlan {
  mode: "global" | "project";
  unchanged: string[];
  modified: string[];
  /** agentsmith's own files for the mode: state, status, and blobs. */
  stateFiles: string[];
  /** Directory empty directories are pruned up to. */
  root: string;
  backupRoot: string;
}

function refuseModified(plan: CleanPlan): AgentsmithError {
  return new AgentsmithError(
    "artifact-modified",
    [
      `Refusing to clean: ${plan.modified.length} ${plan.mode} artifact(s) changed since agentsmith generated them:`,
      ...plan.modified.map((path) => `  ${path}`),
      "Nothing was removed. Pass --on-modified=backup to back them up and remove them, or --force to remove them.",
    ].join("\n"),
  );
}

function report(plan: CleanPlan, options: CleanOptions): void {
  const verb = options.yes ? "Removing" : "Would remove";
  const lines: string[] = [];
  for (const path of plan.unchanged) lines.push(`  ${path}`);
  for (const path of plan.modified) lines.push(`  ${path} (modified; ${options.onModified === "backup" ? `backed up to ${plan.backupRoot} first` : "forced"})`);
  for (const path of plan.stateFiles) lines.push(`  ${path}`);
  if (lines.length === 0) {
    console.log(`Nothing to clean for ${plan.mode} artifacts.`);
    return;
  }
  console.log(`${verb} ${plan.unchanged.length + plan.modified.length} ${plan.mode} artifact(s) and agentsmith state:`);
  console.log(lines.join("\n"));
}

async function removeAll(paths: readonly string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true });
}

/**
 * Remove every recorded global artifact still matching its recorded content, then agentsmith's global state, status,
 * and stored content. Machine config, Source Repository, backups, logs, and the schedule stay.
 */
export async function cleanGlobal(options: CleanOptions): Promise<void> {
  const configPath = resolveConfiguredPath(options.config ?? MACHINE_CONFIG_PATH, resolve(process.cwd(), "config.toml"));
  // Strict: a mistyped sandbox home must not clean the real one.
  const home = await classify("config", () => requireMachineHome(configPath));
  const statePath = globalStatePath(home);
  const state = await classify("config", () => loadGlobalState(statePath));
  const plan: CleanPlan = {
    mode: "global",
    unchanged: [],
    modified: [],
    stateFiles: [],
    root: agentsmithHome(home),
    backupRoot: globalBackupRoot(home),
  };
  for (const [destination, hash] of Object.entries(state.artifacts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!(await present(destination))) continue;
    const stat = await lstat(destination);
    if (stat.isFile() && hashBytes(await readFile(destination)) === hash) plan.unchanged.push(destination);
    else plan.modified.push(destination);
  }
  for (const path of [statePath, globalStatusPath(statePath), globalBlobDirectory(statePath)]) if (await present(path)) plan.stateFiles.push(path);
  if (plan.modified.length > 0 && !options.force && options.onModified !== "backup") throw refuseModified(plan);
  report(plan, options);
  if (!options.yes) {
    if (plan.unchanged.length + plan.modified.length + plan.stateFiles.length > 0) console.log("Dry run; rerun with --yes to remove these files.");
    return;
  }

  let backups: ArtifactBackup[] = [];
  if (plan.modified.length > 0 && options.onModified === "backup") {
    backups = await backupGlobalArtifacts(
      plan.modified.map((destination) => ({ destination, reason: "modified" as const })),
      { plan: { writes: [], deletes: [], diagnostics: [], explanation: null }, state, backupRoot: plan.backupRoot },
    );
  }
  const artifacts = [...plan.unchanged, ...plan.modified];
  await removeAll(artifacts);
  await removeAll(plan.stateFiles);
  await pruneEmptyParents([...artifacts, ...plan.stateFiles], plan.root);
  for (const backup of backups) console.error(`WARNING artifact-backup: moved modified global artifact ${backup.path} to ${backup.backup}`);
  console.log(`Removed ${artifacts.length} global artifact(s) and agentsmith's global state.`);
}

function normalizeScope(value: string): string {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

/** The deepest declared scope containing a project-relative path. */
export function owningScope(path: string, scopes: readonly string[]): string {
  const depth = (scope: string) => (scope === "." ? 0 : scope.split("/").length);
  return scopes.filter((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`)).sort((a, b) => depth(b) - depth(a))[0] ?? ".";
}

/**
 * Remove recorded project artifacts that are unchanged (identical to what the current plan generates, or tracked and
 * clean in Git), optionally only those of one scope, then the project state. Removed tracked files remain Git deletions
 * for the user to commit.
 */
export async function cleanProject(options: CleanOptions): Promise<void> {
  const start = options.project ?? process.cwd();
  const configPath = await classify("config", () => discoverProjectConfig(start));
  const config = await classify("config", () => loadProjectConfig(configPath));
  const projectRoot = canonicalRoot(dirname(dirname(dirname(configPath))));
  const worktree = await gitWorktree(projectRoot);
  const statePath = projectStatePath(worktree);
  const state = await loadProjectState(statePath);
  const scopes = config.scopes.map((scope) => scope.path);
  let scope: string | undefined;
  if (options.scope !== undefined) {
    scope = normalizeScope(options.scope);
    if (!scopes.includes(scope)) throw new AgentsmithError("config", `Scope ${scope} is not declared (scopes: ${scopes.join(", ")})`);
  }
  // Unchanged means the content agentsmith recorded, what this configuration generates, or what Git has committed.
  const planned = new Map<string, Uint8Array>();
  try {
    const built = await buildProjectPlan(start, options.config ?? MACHINE_CONFIG_PATH);
    for (const write of built.writes) planned.set(resolve(write.destination), write.content);
  } catch (cause) {
    console.error(`WARNING clean-plan-unavailable: comparing with Git only, because the project plan failed: ${errorMessage(cause)}`);
  }

  const selected = state.paths.filter((path) => scope === undefined || owningScope(path, scopes) === scope);
  const plan: CleanPlan = {
    mode: "project",
    unchanged: [],
    modified: [],
    stateFiles: [],
    root: worktree.root,
    backupRoot: projectBackupRoot(worktree),
  };
  const tracked: string[] = [];
  for (const path of selected) {
    const absolute = resolve(worktree.root, path);
    if (!(await present(absolute))) continue;
    const status = await gitPathStatus(worktree.root, absolute);
    const content = (await lstat(absolute)).isFile() ? new Uint8Array(await readFile(absolute)) : undefined;
    const expected = planned.get(absolute);
    const matchesPlan = content !== undefined && expected !== undefined && Buffer.from(content).equals(Buffer.from(expected));
    const matchesRecorded = content !== undefined && state.hashes?.[path] === hashBytes(content);
    if (status === "tracked-clean") tracked.push(absolute);
    if (content !== undefined && (matchesRecorded || matchesPlan || status === "tracked-clean")) plan.unchanged.push(absolute);
    else plan.modified.push(absolute);
  }
  const remaining = state.paths.filter((path) => !selected.includes(path));
  if (remaining.length === 0 && (await present(statePath))) plan.stateFiles.push(statePath);
  if (plan.modified.length > 0 && !options.force && options.onModified !== "backup") throw refuseModified(plan);
  report(plan, options);
  if (remaining.length > 0) console.log(`  (state keeps ${remaining.length} recorded path(s) of other scopes)`);
  if (!options.yes) {
    if (plan.unchanged.length + plan.modified.length + plan.stateFiles.length > 0) console.log("Dry run; rerun with --yes to remove these files.");
    return;
  }

  const backups = options.onModified === "backup" ? await quarantinePaths(plan.modified, { backupRoot: plan.backupRoot, reason: "modified" }) : [];
  const artifacts = [...plan.unchanged, ...plan.modified];
  await removeAll(artifacts);
  if (remaining.length > 0) await saveProjectState(statePath, { ...state, paths: remaining });
  else {
    await removeAll(plan.stateFiles);
    await pruneEmptyParents(plan.stateFiles, worktree.gitDir);
  }
  await pruneEmptyParents(artifacts, worktree.root);
  for (const backup of backups) console.error(`WARNING artifact-backup: moved modified project artifact ${backup.path} to ${backup.backup}`);
  console.log(`Removed ${artifacts.length} project artifact(s)${remaining.length > 0 ? ` of scope ${scope}` : " and agentsmith's project state"}.`);
  if (tracked.length > 0) {
    console.log(`${tracked.length} removed file(s) were tracked by Git; review and commit the deletions:`);
    for (const path of tracked) console.log(`  ${relative(worktree.root, path).split(sep).join("/")}`);
  }
}
