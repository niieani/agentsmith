import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";
import type { GenerationPlan, PlannedDelete, PlannedWrite } from "./types.ts";
import { AgentsmithError } from "./errors.ts";
import { gitPathStatus, gitWorktree, type GitWorktree } from "./git.ts";

export interface ProjectState {
  version: 1;
  /** Recorded artifacts, relative to the worktree root. */
  paths: string[];
  /**
   * SHA-256 of each recorded artifact's generated content, keyed by its relative path. A path without a hash was
   * recorded by an older agentsmith; only Git can vouch for it.
   */
  hashes?: Record<string, string>;
  /** Lines agentsmith added to the repository's `info/exclude`. */
  excludes?: string[];
  /** Absolute paths agentsmith added to `claudeMdExcludes` in `<project>/.claude/settings.local.json`. */
  claudeMdExcludes?: string[];
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

/** Global state under `home`: a machine config's sandbox home, or the real home when undefined. */
export function globalStatePath(home?: string): string {
  return join(home ?? homedir(), ".agents", "agentsmith", "state.toml");
}

/** Content-addressed copies of the last generated global artifacts, named by SHA-256. */
export function globalBlobDirectory(statePath = globalStatePath()): string {
  return join(dirname(statePath), "blobs");
}

export function blobPath(blobDirectory: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
  return join(blobDirectory, hash);
}

/** Store content blobs before state references them; existing blobs are reused. */
export async function storeBlobs(blobDirectory: string, contents: Iterable<Uint8Array>): Promise<void> {
  for (const content of contents) {
    const path = blobPath(blobDirectory, hashBytes(content));
    if (await exists(path)) continue;
    await atomicWrite(path, content);
  }
}

/** Read the stored content for a hash, or undefined when it was never stored. */
export async function readBlob(blobDirectory: string, hash: string): Promise<Uint8Array | undefined> {
  const path = blobPath(blobDirectory, hash);
  if (!(await exists(path))) return undefined;
  const content = new Uint8Array(await readFile(path));
  return hashBytes(content) === hash ? content : undefined;
}

/** Remove blobs no longer referenced by state. Only call after state was committed. */
export async function collectBlobs(blobDirectory: string, state: GlobalState): Promise<string[]> {
  if (!(await exists(blobDirectory))) return [];
  const referenced = new Set(Object.values(state.artifacts));
  const removed: string[] = [];
  for (const entry of await readdir(blobDirectory, { withFileTypes: true })) {
    if (referenced.has(entry.name)) continue;
    // Leftover temporary files from interrupted writes are garbage too.
    if (!/^[a-f0-9]{64}$/.test(entry.name) && !entry.name.startsWith(".agentsmith-")) continue;
    await rm(join(blobDirectory, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function loadProjectState(path: string): Promise<ProjectState> {
  if (!(await exists(path))) return { version: 1, paths: [], hashes: {}, excludes: [], claudeMdExcludes: [] };
  const value = parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (value.version !== 1 || !stringArray(value.paths)) throw new Error(`Invalid project state: ${path}`);
  const paths = [...new Set(value.paths)].sort();
  const hashes: Record<string, string> = {};
  if (value.hashes !== undefined) {
    if (value.hashes === null || typeof value.hashes !== "object" || Array.isArray(value.hashes)) throw new Error(`Invalid project state: ${path}`);
    for (const [key, hash] of Object.entries(value.hashes as Record<string, unknown>)) {
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid project artifact hash in ${path}`);
      if (paths.includes(key)) hashes[key] = hash;
    }
  }
  for (const key of ["excludes", "claude_md_excludes"]) {
    if (value[key] !== undefined && !stringArray(value[key])) throw new Error(`Invalid project state ${key}: ${path}`);
  }
  return {
    version: 1,
    paths,
    hashes,
    excludes: [...new Set((value.excludes as string[] | undefined) ?? [])],
    claudeMdExcludes: [...new Set((value.claude_md_excludes as string[] | undefined) ?? [])],
  };
}

/** Serialized project state; keys stay compatible with readers that only know `version` and `paths`. */
export function serializeProjectState(state: ProjectState): string {
  const paths = [...new Set(state.paths)].sort();
  const hashes = Object.fromEntries(
    Object.entries(state.hashes ?? {})
      .filter(([key]) => paths.includes(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return stringify({
    version: 1,
    paths,
    hashes,
    excludes: [...new Set(state.excludes ?? [])],
    claude_md_excludes: [...new Set(state.claudeMdExcludes ?? [])],
  });
}

export async function saveProjectState(path: string, state: ProjectState): Promise<void> {
  await atomicWrite(path, new TextEncoder().encode(serializeProjectState(state)));
}

/** Whether a recorded project artifact still holds exactly the content agentsmith last generated. */
export async function matchesRecordedHash(state: ProjectState, root: string, path: string): Promise<boolean> {
  const hash = state.hashes?.[relative(resolve(root), resolve(path)).replaceAll("\\", "/")];
  if (hash === undefined) return false;
  try {
    const stats = await lstat(path);
    return stats.isFile() && hashBytes(await readFile(path)) === hash;
  } catch {
    return false;
  }
}

export async function loadGlobalState(path = globalStatePath()): Promise<GlobalState> {
  if (!(await exists(path))) return { version: 1, artifacts: {} };
  const value = parse(await readFile(path, "utf8")) as Record<string, unknown>;
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
    if (entry.isDirectory()) files.push(...(await filesBelow(child)));
    else if (entry.isFile()) files.push(resolve(child));
  }
  return files;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether agentsmith may overwrite or delete a project path: Git has it (missing, or tracked and clean), or agentsmith
 * recorded it and its content still matches the recorded hash, whatever Git thinks of it (ignored skills, untracked
 * personal files, or a generated change not yet committed). Conflicted paths are never touched.
 */
async function projectPathReplaceable(root: string, state: ProjectState, destination: string): Promise<{ ok: boolean; status: string }> {
  const status = await gitPathStatus(root, destination);
  if (status === "missing" || status === "tracked-clean") return { ok: true, status };
  if (status !== "conflicted" && (await matchesRecordedHash(state, root, destination))) return { ok: true, status };
  return { ok: false, status: state.paths.includes(relative(root, destination).replaceAll("\\", "/")) ? `${status} and edited` : status };
}

/**
 * Skill directories a project plan writes that already hold content agentsmith does not own: a file that is neither
 * recorded in state nor planned with identical bytes. Such a directory was committed by the repository's authors or
 * written by hand, and generating over it would silently replace it.
 */
async function unownedSkillDirectories(plan: GenerationPlan, root: string, state: ProjectState): Promise<string[]> {
  const recorded = new Set(state.paths.map((path) => resolve(root, path)));
  const planned = new Map(plan.writes.map((write) => [resolve(write.destination), write.content]));
  const directories = new Set(plan.writes.flatMap((write) => (write.skillDirectory === undefined ? [] : [resolve(write.skillDirectory)])));
  const unowned: string[] = [];
  for (const directory of [...directories].sort()) {
    for (const file of await filesBelow(directory)) {
      if (recorded.has(file)) continue;
      const content = planned.get(file);
      if (content !== undefined && Buffer.from(await readFile(file)).equals(Buffer.from(content))) continue;
      unowned.push(directory);
      break;
    }
  }
  return unowned;
}

export async function preflightProjectPlan(plan: GenerationPlan, options: { projectRoot: string; state: ProjectState }): Promise<void> {
  assertUniqueDestinations(plan);
  const expected = await gitWorktree(options.projectRoot);
  const recorded = new Set(options.state.paths.map((path) => resolve(expected.root, path)));
  const plannedDeletions = new Set(plan.deletes.map((item) => resolve(item.destination)));
  const unowned = await unownedSkillDirectories(plan, expected.root, options.state);
  if (unowned.length > 0) {
    throw new AgentsmithError(
      "config",
      [
        `Generated skill(s) would replace skill directories agentsmith does not own:`,
        ...unowned.map((path) => `  ${path}`),
        "They were committed by the repository's authors or written by hand. Rename the generated skill, or adopt the directory with `asmith project adopt --skill NAME`.",
      ].join("\n"),
    );
  }
  for (const write of plan.writes) {
    const destination = resolve(write.destination);
    if (!inside(expected.root, destination)) throw new Error(`Project destination escapes its worktree: ${destination}`);
    await rejectSymlink(destination);
    const existing = await nearestExisting(destination);
    const owner = await gitWorktree((await stat(existing)).isDirectory() ? existing : dirname(existing));
    if (owner.root !== expected.root || owner.gitDir !== expected.gitDir) throw new Error(`Destination belongs to a different Git worktree: ${destination}`);
    const replaceable = await projectPathReplaceable(expected.root, options.state, destination);
    if (!replaceable.ok) throw new Error(`Refusing to replace ${replaceable.status} project destination: ${destination}`);
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
    const replaceable = await projectPathReplaceable(expected.root, options.state, destination);
    if (!replaceable.ok) throw new Error(`Refusing to delete ${replaceable.status} stale project artifact: ${destination}`);
  }
}

export type GlobalConflictReason = "modified" | "unrecorded" | "modified-stale";

export interface GlobalConflict {
  destination: string;
  reason: GlobalConflictReason;
}

export interface GlobalPreflightOptions {
  state: GlobalState;
  force?: boolean;
  /** `backup` returns conflicts for the caller to move aside instead of failing. */
  onModified?: "fail" | "backup";
  /** Destinations the caller has already reconciled and may replace. */
  accept?: ReadonlySet<string>;
}

function conflictError(conflict: GlobalConflict): AgentsmithError {
  const message =
    conflict.reason === "unrecorded"
      ? `Refusing to adopt existing unrecorded global artifact: ${conflict.destination}`
      : conflict.reason === "modified"
        ? `Refusing to replace modified global artifact: ${conflict.destination}`
        : `Refusing to delete modified stale global artifact: ${conflict.destination}`;
  return new AgentsmithError("artifact-modified", message);
}

/**
 * Validate a global plan against recorded state. Conflicting artifacts fail
 * the plan, or with `onModified: "backup"` are returned for backup.
 */
export async function preflightGlobalPlan(plan: GenerationPlan, options: GlobalPreflightOptions): Promise<GlobalConflict[]> {
  assertUniqueDestinations(plan);
  const backup = options.onModified === "backup";
  const conflicts: GlobalConflict[] = [];
  const conflict = (item: GlobalConflict) => {
    if (!backup) throw conflictError(item);
    conflicts.push(item);
  };
  const plannedDeletions = new Set(plan.deletes.map((item) => resolve(item.destination)));
  for (const write of plan.writes) {
    const destination = resolve(write.destination);
    await rejectSymlink(destination);
    if (!(await exists(destination))) continue;
    const destinationIsDirectory = (await lstat(destination)).isDirectory();
    const recordedHash = options.state.artifacts[destination];
    if (!destinationIsDirectory && !options.accept?.has(destination)) {
      if (recordedHash === undefined) {
        if (!options.force || backup) conflict({ destination, reason: "unrecorded" });
      } else if ((!options.force || backup) && hashBytes(await readFile(destination)) !== recordedHash) {
        conflict({ destination, reason: "modified" });
      }
    }
    for (const child of await filesBelow(destination)) {
      const childHash = options.state.artifacts[child];
      if (childHash === undefined || !plannedDeletions.has(child) || hashBytes(await readFile(child)) !== childHash) {
        throw new AgentsmithError("artifact-modified", `Refusing file/directory transition over unowned global content: ${child}`);
      }
    }
  }
  for (const deletion of plan.deletes) {
    const destination = resolve(deletion.destination);
    await rejectSymlink(destination);
    const recordedHash = options.state.artifacts[destination];
    if (recordedHash === undefined) throw new AgentsmithError("artifact-modified", `Refusing to delete unrecorded global artifact: ${destination}`);
    if ((await exists(destination)) && hashBytes(await readFile(destination)) !== recordedHash) {
      conflict({ destination, reason: "modified-stale" });
    }
  }
  return conflicts;
}

/** Why a path was moved aside: a conflicting artifact, or a skill exclusive mode does not allow. */
export type BackupReason = GlobalConflictReason | "unmanaged";

export interface ArtifactBackup {
  /** The artifact path that was moved aside: a file, or a whole skill directory. */
  path: string;
  backup: string;
  reason: BackupReason;
}

/** `20261110T120000Z` for a backup suffix. */
export function backupTimestamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
}

/** The skill directory owning a path: its nearest ancestor whose SKILL.md is known. */
function owningSkillDirectory(path: string, knownFiles: ReadonlySet<string>): string | undefined {
  let current = dirname(path);
  while (true) {
    if (knownFiles.has(join(current, "SKILL.md"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Where whole skill directories are moved, outside every skill root so no harness loads them. */
export function globalBackupRoot(home?: string): string {
  return join(home ?? homedir(), ".agents", "agentsmith", "backups");
}

/** Where a project's backups go: beside its state, under the worktree's Git directory, so Git never sees them. */
export function projectBackupRoot(worktree: GitWorktree): string {
  return join(worktree.gitDir, "agentsmith", "backups");
}

/**
 * Move whole directories, such as unmanaged skills, to `<backupRoot>/<UTC timestamp>/<original absolute path>`,
 * outside every skill root. Already moved directories are put back if a later move fails.
 */
export async function quarantinePaths(
  paths: readonly string[],
  options: { backupRoot: string; date?: Date; reason?: BackupReason },
): Promise<ArtifactBackup[]> {
  const stamp = backupTimestamp(options.date);
  const backups: ArtifactBackup[] = [];
  try {
    for (const path of paths) {
      if (!(await exists(path))) continue;
      const base = join(options.backupRoot, stamp, resolve(path).slice(1));
      let backup = base;
      for (let attempt = 1; await exists(backup); attempt++) backup = `${base}-${attempt}`;
      await moveAside(path, backup);
      backups.push({ path, backup, reason: options.reason ?? "unmanaged" });
    }
  } catch (error) {
    await restoreBackups(backups);
    throw error;
  }
  return backups;
}

async function moveAside(path: string, backup: string): Promise<void> {
  await mkdir(dirname(backup), { recursive: true });
  try {
    await rename(path, backup);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
    await cp(path, backup, { recursive: true, errorOnExist: true, force: false });
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * Move conflicting global artifacts aside. An instruction file becomes `<name>.agentsmith-<UTC timestamp>` beside the
 * original, which no harness reads. A conflicting skill file backs up its whole skill directory to
 * `<backupRoot>/<UTC timestamp>/<original absolute path>`: a renamed directory left in the skill root would still be
 * discovered, and Codex would load two skills with the same name.
 */
export async function backupGlobalArtifacts(
  conflicts: readonly GlobalConflict[],
  options: { plan: GenerationPlan; state: GlobalState; date?: Date; backupRoot?: string },
): Promise<ArtifactBackup[]> {
  const known = new Set([
    ...Object.keys(options.state.artifacts).map((path) => resolve(path)),
    ...options.plan.writes.filter((write) => write.kind === "skill").map((write) => resolve(write.destination)),
  ]);
  const stamp = backupTimestamp(options.date);
  const backups: ArtifactBackup[] = [];
  const moved = new Set<string>();
  try {
    for (const item of conflicts) {
      const skillDirectory = owningSkillDirectory(item.destination, known);
      const path = skillDirectory ?? item.destination;
      if (moved.has(path) || !(await exists(path))) continue;
      const base = skillDirectory === undefined ? `${path}.agentsmith-${stamp}` : join(options.backupRoot ?? globalBackupRoot(), stamp, resolve(path).slice(1));
      let backup = base;
      for (let attempt = 1; await exists(backup); attempt++) backup = `${base}-${attempt}`;
      await moveAside(path, backup);
      moved.add(path);
      backups.push({ path, backup, reason: item.reason });
    }
  } catch (error) {
    await restoreBackups(backups);
    throw error;
  }
  return backups;
}

/** Undo backups after a failed application, putting each artifact back in place. */
export async function restoreBackups(backups: readonly ArtifactBackup[]): Promise<void> {
  for (const entry of [...backups].reverse()) {
    await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
    await moveAside(entry.backup, entry.path).catch(() => undefined);
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

export async function atomicWrite(destination: string, content: Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.agentsmith-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content);
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
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
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
