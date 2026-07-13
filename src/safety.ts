import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";
import type { GenerationPlan, PlannedDelete, PlannedWrite } from "./types.ts";
import { gitPathStatus, gitWorktree, type GitWorktree } from "./git.ts";

export interface ProjectState {
  version: 1;
  paths: string[];
}

export interface GlobalState {
  version: 1;
  artifacts: Record<string, string>;
}

export function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function projectStatePath(worktree: GitWorktree): string {
  return join(worktree.gitDir, "agentsmith", "state.toml");
}

export function globalStatePath(home = homedir()): string {
  return join(home, ".agents", "agentsmith", "state.toml");
}

export async function loadProjectState(path: string): Promise<ProjectState> {
  if (!(await Bun.file(path).exists())) return { version: 1, paths: [] };
  const value = parse(await Bun.file(path).text()) as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.paths) || value.paths.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid project state: ${path}`);
  }
  return { version: 1, paths: [...new Set(value.paths as string[])].sort() };
}

export async function saveProjectState(path: string, state: ProjectState): Promise<void> {
  await atomicWrite(path, new TextEncoder().encode(stringify({ version: 1, paths: [...new Set(state.paths)].sort() })));
}

export async function loadGlobalState(path = globalStatePath()): Promise<GlobalState> {
  if (!(await Bun.file(path).exists())) return { version: 1, artifacts: {} };
  const value = parse(await Bun.file(path).text()) as Record<string, unknown>;
  const artifacts = value.artifacts;
  if (value.version !== 1 || artifacts === null || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error(`Invalid global state: ${path}`);
  }
  const checked: Record<string, string> = {};
  for (const [destination, hash] of Object.entries(artifacts as Record<string, unknown>)) {
    if (!isAbsolute(destination) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid global artifact state in ${path}`);
    }
    checked[destination] = hash;
  }
  return { version: 1, artifacts: checked };
}

export async function saveGlobalState(path: string, state: GlobalState): Promise<void> {
  const artifacts = Object.fromEntries(Object.entries(state.artifacts).sort(([a], [b]) => a.localeCompare(b)));
  await atomicWrite(path, new TextEncoder().encode(stringify({ version: 1, artifacts })));
}

function assertUniqueDestinations(plan: GenerationPlan): void {
  const seen = new Set<string>();
  for (const item of [...plan.writes, ...plan.deletes]) {
    const path = resolve(item.destination);
    if (seen.has(path)) throw new Error(`Plan contains duplicate destination: ${path}`);
    seen.add(path);
  }
}

async function rejectSymlink(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink destination or ancestor is not allowed: ${current}`);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function filesBelow(path: string): Promise<string[]> {
  if (!(await exists(path)) || !(await lstat(path)).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink destination content is not allowed: ${child}`);
    if (entry.isDirectory()) files.push(...await filesBelow(child));
    else if (entry.isFile()) files.push(resolve(child));
  }
  return files;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function preflightProjectPlan(
  plan: GenerationPlan,
  options: { projectRoot: string; state: ProjectState },
): Promise<void> {
  assertUniqueDestinations(plan);
  const expected = await gitWorktree(options.projectRoot);
  const recorded = new Set(options.state.paths.map((path) => resolve(expected.root, path)));
  const plannedDeletions = new Set(plan.deletes.map((item) => resolve(item.destination)));
  for (const write of plan.writes) {
    const destination = resolve(write.destination);
    if (!inside(expected.root, destination)) throw new Error(`Project destination escapes its worktree: ${destination}`);
    await rejectSymlink(destination);
    const existing = await nearestExisting(destination);
    const owner = await gitWorktree((await stat(existing)).isDirectory() ? existing : dirname(existing));
    if (owner.root !== expected.root || owner.gitDir !== expected.gitDir) throw new Error(`Destination belongs to a different Git worktree: ${destination}`);
    const status = await gitPathStatus(expected.root, destination);
    if (status !== "missing" && status !== "tracked-clean") throw new Error(`Refusing to replace ${status} project destination: ${destination}`);
    for (const child of await filesBelow(destination)) {
      if (!recorded.has(child) || !plannedDeletions.has(child)) {
        throw new Error(`Refusing file/directory transition over unowned project content: ${child}`);
      }
    }
  }
  for (const deletion of plan.deletes) {
    const destination = resolve(deletion.destination);
    if (!recorded.has(destination)) throw new Error(`Refusing to delete unrecorded project artifact: ${destination}`);
    if (!inside(expected.root, destination)) throw new Error(`Project deletion escapes its worktree: ${destination}`);
    await rejectSymlink(destination);
    const status = await gitPathStatus(expected.root, destination);
    if (status !== "missing" && status !== "tracked-clean") throw new Error(`Refusing to delete ${status} stale project artifact: ${destination}`);
  }
}

export async function preflightGlobalPlan(
  plan: GenerationPlan,
  options: { state: GlobalState; force?: boolean },
): Promise<void> {
  assertUniqueDestinations(plan);
  const plannedDeletions = new Set(plan.deletes.map((item) => resolve(item.destination)));
  for (const write of plan.writes) {
    const destination = resolve(write.destination);
    await rejectSymlink(destination);
    if (!(await exists(destination))) continue;
    const destinationIsDirectory = (await lstat(destination)).isDirectory();
    const recordedHash = options.state.artifacts[destination];
    if (!destinationIsDirectory && recordedHash === undefined) {
      if (!options.force) throw new Error(`Refusing to adopt existing unrecorded global artifact: ${destination}`);
    } else if (!destinationIsDirectory && !options.force && hashBytes(await readFile(destination)) !== recordedHash) {
      throw new Error(`Refusing to replace modified global artifact: ${destination}`);
    }
    for (const child of await filesBelow(destination)) {
      const childHash = options.state.artifacts[child];
      if (childHash === undefined || !plannedDeletions.has(child) || hashBytes(await readFile(child)) !== childHash) {
        throw new Error(`Refusing file/directory transition over unowned global content: ${child}`);
      }
    }
  }
  for (const deletion of plan.deletes) {
    const destination = resolve(deletion.destination);
    await rejectSymlink(destination);
    const recordedHash = options.state.artifacts[destination];
    if (recordedHash === undefined) throw new Error(`Refusing to delete unrecorded global artifact: ${destination}`);
    if ((await exists(destination)) && hashBytes(await readFile(destination)) !== recordedHash) {
      throw new Error(`Refusing to delete modified stale global artifact: ${destination}`);
    }
  }
}

async function nearestExisting(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing ancestor for ${path}`);
    current = parent;
  }
}

async function atomicWrite(destination: string, content: Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.agentsmith-${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temporary, content);
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

type Operation = PlannedWrite | PlannedDelete;

/** Apply an already-preflighted plan transactionally, restoring every prior path on failure. */
export async function applyPlan(
  plan: GenerationPlan,
  options: { beforeOperation?: (operation: Operation, index: number) => void | Promise<void> } = {},
): Promise<void> {
  assertUniqueDestinations(plan);
  // Stale paths go first so an owned file can become a directory (or vice
  // versa) in the same transaction. Preflight proves that any directory being
  // replaced contains only owned stale paths.
  const operations: Operation[] = [...plan.deletes, ...plan.writes];
  const backups: Array<{ destination: string; backup?: string }> = [];
  const transactionId = crypto.randomUUID();
  try {
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      await options.beforeOperation?.(operation, index);
      const destination = resolve(operation.destination);
      await mkdir(dirname(destination), { recursive: true });
      let backup: string | undefined;
      if (await exists(destination)) {
        backup = join(dirname(destination), `.agentsmith-backup-${transactionId}-${index}`);
        await rename(destination, backup);
      }
      backups.push({ destination, backup });
      if ("content" in operation) await atomicWrite(destination, operation.content, operation.mode);
    }
  } catch (error) {
    for (const entry of backups.reverse()) {
      await rm(entry.destination, { recursive: true, force: true }).catch(() => undefined);
      if (entry.backup !== undefined) await rename(entry.backup, entry.destination).catch(() => undefined);
    }
    throw error;
  } finally {
    for (const entry of backups) {
      if (entry.backup !== undefined) await rm(entry.backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function unifiedDiff(before: string, after: string, path = "artifact"): string {
  if (before === after) return "";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldChanged.length} +${newStart},${newChanged.length} @@`,
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    "",
  ].join("\n");
}
