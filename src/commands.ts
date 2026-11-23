import { existsSync } from "node:fs";
import { readFile, rmdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { stringify } from "smol-toml";
import { loadMachineConfig, MACHINE_CONFIG_PATH, readMachineHome, resolveConfiguredPath } from "./config.ts";
import { addSnippet, type Placement } from "./add.ts";
import { adoptGlobal } from "./adopt.ts";
import { adoptSkill } from "./adopt-skill.ts";
import { cleanGlobal, cleanProject } from "./clean.ts";
import { AgentsmithError, classify, errorCode, errorMessage, exitCodeFor } from "./errors.ts";
import { CommandError, ensureCleanSource, gitHasTracked, gitHeadCommit, gitIsTracked, gitPathStatus, gitPullFfOnly, gitWorktree } from "./git.ts";
import { assertPlanValid, buildGlobalPlan, buildProjectPlan, type BuiltPlan, type UnmanagedSkill } from "./planner.ts";
import { isWithin } from "./fs.ts";
import { skillRootSuffixes } from "./harness.ts";
import {
  applyPlan,
  backupGlobalArtifacts,
  collectBlobs,
  globalBackupRoot,
  globalBlobDirectory,
  globalStatePath,
  hashBytes,
  loadGlobalState,
  loadProjectState,
  preflightGlobalPlan,
  preflightProjectPlan,
  projectBackupRoot,
  projectStatePath,
  quarantinePaths,
  restoreBackups,
  serializeProjectState,
  storeBlobs,
  unifiedDiff,
  type ArtifactBackup,
  type GlobalState,
  type ProjectState,
} from "./safety.ts";
import { globalInit } from "./init.ts";
import { projectInit } from "./project-init.ts";
import {
  claudeLocalSettingsPath,
  desiredExcludes,
  excludeEntry,
  infoExcludePath,
  readInfoExclude,
  readClaudeSettings,
  updateClaudeMdExcludes,
  updateInfoExclude,
} from "./personal.ts";
import { installSchedule, printScheduleStatus, uninstallSchedule } from "./schedule.ts";
import { globalStatusPath, printGlobalStatus, writeGlobalStatus, type RunReport } from "./status.ts";
import type { Diagnostic, GenerationPlan, HarnessName, PlannedDelete, PlannedWrite } from "./types.ts";

const encoder = new TextEncoder();

export interface CommandOptions {
  action?: CommandAction;
  config?: string;
  project?: string;
  force?: boolean;
  json?: boolean;
  warningsAsErrors?: boolean;
  onModified?: "fail" | "backup";
  maxAge?: string;
  slot?: string;
  pack?: string;
  dryRun?: boolean;
  url?: string;
  profile?: string;
  source?: string;
  schedule?: boolean;
  interval?: string;
  yes?: boolean;
  text?: string;
  file?: string;
  skillSlot?: boolean;
  harness?: HarnessName;
  placement?: Placement;
  name?: string;
  local?: boolean;
  push?: boolean;
  noCommit?: boolean;
  skipGenerate?: boolean;
  scope?: string;
  skill?: string;
  prepare?: boolean;
  template?: string;
}

export function diagnosticsText(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((item) => {
      const location = item.path ? ` (${item.path})` : "";
      return `${item.severity.toUpperCase()} ${item.code}: ${item.message}${location}`;
    })
    .join("\n");
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  if (diagnostics.length > 0) console.error(diagnosticsText(diagnostics));
}

function warn(report: RunReport | undefined, message: string): void {
  console.error(message);
  report?.warnings.push(message);
}

function relativeStatePath(root: string, path: string): string {
  return relative(root, resolve(path)).replaceAll("\\", "/");
}

async function prepareProjectPlan(plan: BuiltPlan): Promise<{
  worktree: Awaited<ReturnType<typeof gitWorktree>>;
  statePath: string;
  previous: ProjectState;
}> {
  const worktree = await gitWorktree(plan.projectRoot!);
  const statePath = projectStatePath(worktree);
  const previous = await loadProjectState(statePath);
  const current = new Set(plan.plannedPaths.map((path) => relativeStatePath(worktree.root, path)));
  plan.deletes = previous.paths
    .filter((path) => !current.has(path))
    .map((path): PlannedDelete => ({ destination: resolve(worktree.root, path), kind: "skill" }));
  return { worktree, statePath, previous };
}

export async function prepareGlobalPlan(plan: BuiltPlan): Promise<{
  statePath: string;
  previous: GlobalState;
}> {
  const statePath = globalStatePath(plan.home);
  const previous = await loadGlobalState(statePath);
  const current = new Set(plan.plannedPaths.map((path) => resolve(path)));
  plan.deletes = Object.keys(previous.artifacts)
    .filter((path) => !current.has(resolve(path)))
    .map((path): PlannedDelete => ({ destination: path, kind: "skill" }));
  return { statePath, previous };
}

function projectStateWrite(statePath: string, root: string, plan: BuiltPlan, extra: Pick<ProjectState, "excludes" | "claudeMdExcludes"> = {}): PlannedWrite {
  const artifacts = plan.writes.filter((write) => write.kind !== "state");
  const state: ProjectState = {
    version: 1,
    paths: artifacts.map((write) => relativeStatePath(root, write.destination)),
    hashes: Object.fromEntries(artifacts.map((write) => [relativeStatePath(root, write.destination), hashBytes(write.content)])),
    ...extra,
  };
  return {
    destination: statePath,
    content: encoder.encode(serializeProjectState(state)),
    kind: "state",
    provenance: [plan.configPath],
  };
}

function globalStateWrite(statePath: string, plan: BuiltPlan): PlannedWrite {
  const entries: Array<[string, string]> = plan.writes
    .filter((write) => write.kind !== "state")
    .map((write) => [resolve(write.destination), hashBytes(write.content)] as [string, string]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const artifacts = Object.fromEntries(entries);
  return {
    destination: statePath,
    content: encoder.encode(stringify({ version: 1, artifacts })),
    kind: "state",
    provenance: [plan.configPath],
  };
}

async function pruneEmptySkillDirectories(deletions: PlannedDelete[], report?: RunReport): Promise<void> {
  for (const deletion of deletions) {
    const normalized = resolve(deletion.destination);
    const markers = skillRootSuffixes().map((root) => `${sep}${root.split(/[\\/]/).join(sep)}${sep}`);
    const marker = markers.find((candidate) => normalized.includes(candidate));
    if (!marker) continue;
    const markerIndex = normalized.indexOf(marker);
    const skillRoot = normalized.slice(0, markerIndex + marker.length - 1);
    let current = dirname(normalized);
    while (current === skillRoot || current.startsWith(`${skillRoot}${sep}`)) {
      try {
        await rmdir(current);
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || (cause.code !== "ENOENT" && cause.code !== "ENOTEMPTY")) {
          warn(report, `WARNING stale-directory-cleanup: could not remove empty directory ${current}: ${errorMessage(cause)}`);
          break;
        }
        if (cause instanceof Error && "code" in cause && cause.code === "ENOTEMPTY") break;
      }
      if (current === skillRoot) break;
      current = dirname(current);
    }
  }
}

/** Exclusive-mode unmanaged skills, minus directories holding artifacts agentsmith recorded (such as stale skills). */
export function exclusiveViolations(plan: Pick<BuiltPlan, "unmanagedSkills">, recorded: Iterable<string>): UnmanagedSkill[] {
  const files = [...recorded].map((path) => resolve(path));
  return plan.unmanagedSkills.filter((skill) => !files.some((file) => isWithin(skill.path, file)));
}

export function unmanagedSkillsError(mode: "global" | "project", skills: readonly UnmanagedSkill[]): AgentsmithError {
  return new AgentsmithError(
    "artifact-modified",
    [
      `Exclusive mode found ${skills.length} unmanaged skill(s) that agentsmith did not write:`,
      ...skills.map((skill) => `  ${skill.path}`),
      `Adopt one with \`asmith ${mode} adopt --skill NAME\`, allow it with exclusive_allow, or move them to backups with --on-modified=backup.`,
    ].join("\n"),
  );
}

/** Paths a plan's state records: global destinations, or project paths resolved against the worktree. */
export async function recordedPaths(plan: BuiltPlan): Promise<string[]> {
  if (plan.mode === "global") return Object.keys((await loadGlobalState(globalStatePath(plan.home))).artifacts);
  try {
    const worktree = await gitWorktree(plan.projectRoot!);
    return (await loadProjectState(projectStatePath(worktree))).paths.map((path) => resolve(worktree.root, path));
  } catch {
    return [];
  }
}

export interface ProjectGenerateOptions {
  onModified?: "fail" | "backup";
}

/**
 * The `info/exclude` and `claudeMdExcludes` entries a project plan needs, the `claudeMdExcludes` entries its previous run
 * owned, and the lines `info/exclude` already has. `info/exclude` lines are only ever added.
 */
export interface ProjectEntries {
  excludePath: string;
  settingsPath: string;
  excludes: string[];
  claudeMdExcludes: string[];
  presentExcludes: string[];
  previousClaudeMdExcludes: string[];
}

async function untrackedDirectories(root: string, paths: readonly string[]): Promise<string[]> {
  const untracked: string[] = [];
  for (const path of paths) if (!(await gitHasTracked(root, path))) untracked.push(path);
  return untracked;
}

/** A third-party repository's committed files belong to its authors; agentsmith writes only untracked personal files. */
async function refuseCommittedUpstreamWrites(plan: BuiltPlan, root: string): Promise<void> {
  if (plan.upstream === undefined) return;
  const committed: string[] = [];
  for (const write of plan.writes) if (await gitIsTracked(root, write.destination)) committed.push(write.destination);
  if (committed.length > 0) {
    throw new AgentsmithError(
      "config",
      [
        `upstream = "${plan.upstream}": agentsmith never writes a repository's committed files, but the plan would replace:`,
        ...committed.map((path) => `  ${path}`),
      ].join("\n"),
    );
  }
}

export async function projectEntries(plan: BuiltPlan, worktreeRoot: string, previous: ProjectState): Promise<ProjectEntries> {
  const settingsPath = claudeLocalSettingsPath(plan.projectRoot!);
  const previousClaudeMdExcludes = previous.claudeMdExcludes ?? [];
  const personal = plan.writes.filter((write) => write.layer === "personal").map((write) => write.destination);
  const excludePath = await infoExcludePath(worktreeRoot);
  const presentExcludes = await readInfoExclude(excludePath);
  const entries: ProjectEntries = {
    excludePath,
    settingsPath,
    excludes: [
      ...(await desiredExcludes(worktreeRoot, plan.projectRoot!, personal, plan.claudeMdExcludes, presentExcludes)),
      ...(await untrackedDirectories(worktreeRoot, plan.personalExcludes)).map((path) => excludeEntry(worktreeRoot, path, true)),
    ],
    claudeMdExcludes: plan.claudeMdExcludes,
    presentExcludes,
    previousClaudeMdExcludes,
  };
  // Validate the settings file before anything is written.
  if (entries.claudeMdExcludes.length > 0 || previousClaudeMdExcludes.length > 0) await readClaudeSettings(settingsPath);
  if (
    entries.claudeMdExcludes.length > 0 &&
    (await gitPathStatus(worktreeRoot, settingsPath)) !== "missing" &&
    (await gitIsTracked(worktreeRoot, settingsPath))
  ) {
    throw new AgentsmithError(
      "config",
      `${settingsPath} is tracked by Git, but agentsmith writes this machine's paths into its claudeMdExcludes; untrack it (git rm --cached) and ignore it`,
    );
  }
  return entries;
}

export async function generateProject(plan: BuiltPlan, options: ProjectGenerateOptions = {}): Promise<void> {
  await classify("config", () => assertPlanValid(plan));
  printDiagnostics(plan.diagnostics.filter((item) => item.severity !== "error"));
  const prepared = await prepareProjectPlan(plan);
  await refuseCommittedUpstreamWrites(plan, prepared.worktree.root);
  await preflightProjectPlan(plan, { projectRoot: plan.projectRoot!, state: prepared.previous });
  const unmanaged = exclusiveViolations(
    plan,
    prepared.previous.paths.map((path) => resolve(prepared.worktree.root, path)),
  );
  if (unmanaged.length > 0 && options.onModified !== "backup") throw unmanagedSkillsError("project", unmanaged);
  const entries = await projectEntries(plan, prepared.worktree.root, prepared.previous);
  const application: GenerationPlan = {
    ...plan,
    writes: [
      ...plan.writes,
      projectStateWrite(prepared.statePath, prepared.worktree.root, plan, { excludes: entries.excludes, claudeMdExcludes: entries.claudeMdExcludes }),
    ],
  };
  const quarantined = await quarantinePaths(
    unmanaged.map((skill) => skill.path),
    { backupRoot: projectBackupRoot(prepared.worktree) },
  );
  // Never leave CLAUDE.md excluded without its CLAUDE.local.md: Claude would fall back to AGENTS.md. Stale entries go
  // before their personal files are deleted, new ones after their files are written.
  const staleClaude = entries.previousClaudeMdExcludes.filter((entry) => !entries.claudeMdExcludes.includes(entry));
  try {
    await updateClaudeMdExcludes(entries.settingsPath, [], staleClaude);
    await applyPlan(application);
  } catch (cause) {
    await restoreBackups(quarantined);
    await updateClaudeMdExcludes(entries.settingsPath, staleClaude, []).catch(() => undefined);
    throw cause;
  }
  await updateClaudeMdExcludes(entries.settingsPath, entries.claudeMdExcludes, staleClaude);
  await updateInfoExclude(entries.excludePath, entries.excludes);
  for (const backup of quarantined) console.error(`WARNING unmanaged-skill-backup: moved unmanaged skill ${backup.path} to ${backup.backup}`);
  await pruneEmptySkillDirectories(plan.deletes);
  console.log(`Generated ${plan.writes.length} file(s); removed ${plan.deletes.length} stale file(s).`);
}

export interface GlobalGenerateOptions {
  force?: boolean;
  onModified?: "fail" | "backup";
  /** Destinations already reconciled by the caller (for example, adopted edits). */
  accept?: ReadonlySet<string>;
}

/**
 * Generate global artifacts. Generated content is stored as content-addressed
 * blobs before the state that references them is committed, and unreferenced
 * blobs are collected only after the transaction succeeds.
 */
export async function generateGlobal(plan: BuiltPlan, options: GlobalGenerateOptions, report?: RunReport): Promise<void> {
  await classify("config", () => assertPlanValid(plan));
  for (const item of plan.diagnostics.filter((diagnostic) => diagnostic.severity === "warning")) warn(report, diagnosticsText([item]));
  const prepared = await prepareGlobalPlan(plan);
  const conflicts = await preflightGlobalPlan(plan, {
    state: prepared.previous,
    force: options.force,
    onModified: options.onModified,
    accept: options.accept,
  });
  const unmanaged = exclusiveViolations(plan, Object.keys(prepared.previous.artifacts));
  if (unmanaged.length > 0 && options.onModified !== "backup") throw unmanagedSkillsError("global", unmanaged);
  const blobs = globalBlobDirectory(prepared.statePath);
  await storeBlobs(
    blobs,
    plan.writes.map((write) => write.content),
  );
  const backupRoot = globalBackupRoot(plan.home);
  const backups: ArtifactBackup[] = await backupGlobalArtifacts(conflicts, { plan, state: prepared.previous, backupRoot });
  try {
    backups.push(
      ...(await quarantinePaths(
        unmanaged.map((skill) => skill.path),
        { backupRoot },
      )),
    );
  } catch (cause) {
    await restoreBackups(backups);
    throw cause;
  }
  const application: GenerationPlan = {
    ...plan,
    writes: [...plan.writes, globalStateWrite(prepared.statePath, plan)],
  };
  try {
    await applyPlan(application);
  } catch (cause) {
    await restoreBackups(backups);
    throw cause;
  }
  for (const backup of backups) {
    report?.backups.push(backup);
    warn(
      report,
      backup.reason === "unmanaged"
        ? `WARNING unmanaged-skill-backup: moved unmanaged skill ${backup.path} to ${backup.backup}`
        : `WARNING artifact-backup: moved ${backup.reason} global artifact ${backup.path} to ${backup.backup}`,
    );
  }
  await pruneEmptySkillDirectories(plan.deletes, report);
  try {
    await collectBlobs(blobs, await loadGlobalState(prepared.statePath));
  } catch (cause) {
    warn(report, `WARNING blob-cleanup: could not remove unreferenced stored content: ${errorMessage(cause)}`);
  }
  console.log(`Generated ${plan.writes.length} file(s); removed ${plan.deletes.length} stale file(s).`);
}

/** Run `global sync` or `global generate` and always record the outcome in status.json. */
export async function runRecordedGlobal(action: "sync" | "generate", options: CommandOptions): Promise<void> {
  const startedAt = new Date();
  const report: RunReport = { warnings: [], backups: [] };
  let failure: unknown;
  const configPath = resolveConfiguredPath(options.config ?? MACHINE_CONFIG_PATH, resolve(process.cwd(), "config.toml"));
  try {
    const machine = await classify("config", () => loadMachineConfig(configPath));
    report.profile = machine.profile;
    if (action === "sync") {
      await ensureCleanSource(machine.source);
      await gitPullFfOnly(machine.source);
    }
    report.sourceCommit = await gitHeadCommit(machine.source);
    const plan = await classify("config", () => buildGlobalPlan(configPath));
    await generateGlobal(plan, { force: options.force, onModified: options.onModified }, report);
  } catch (cause) {
    failure = cause;
  }
  try {
    await writeGlobalStatus(
      {
        version: 1,
        command: action,
        startedAt: startedAt.toISOString(),
        timestamp: new Date().toISOString(),
        profile: report.profile ?? null,
        sourceCommit: report.sourceCommit ?? null,
        outcome: failure === undefined ? "success" : "failure",
        exitCode: failure === undefined ? 0 : exitCodeFor(failure),
        error: failure === undefined ? null : { code: errorCode(failure), message: errorMessage(failure) },
        warnings: report.warnings,
        backups: report.backups.map(({ path, backup, reason }) => ({ path, backup, reason })),
      },
      globalStatusPath(globalStatePath(readMachineHome(configPath))),
    );
  } catch (cause) {
    console.error(`WARNING status-write: could not record run status: ${errorMessage(cause)}`);
  }
  if (failure !== undefined) throw failure;
}

async function diffPlan(plan: BuiltPlan): Promise<void> {
  let entries: ProjectEntries | undefined;
  if (plan.mode === "project") {
    try {
      const prepared = await prepareProjectPlan(plan);
      entries = await projectEntries(plan, prepared.worktree.root, prepared.previous);
    } catch (cause) {
      const unavailable = cause instanceof CommandError && /not a git repository/i.test(`${cause.result.stderr}\n${cause.result.stdout}`);
      if (!unavailable) throw cause;
      plan.diagnostics.push({
        severity: "warning",
        code: "project-diff-without-git-state",
        message: `Stale artifact deletions were not included because Git state is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: plan.projectRoot,
      });
    }
  } else await prepareGlobalPlan(plan);
  await classify("config", () => assertPlanValid(plan));
  printDiagnostics(plan.diagnostics);
  let output = "";
  for (const write of plan.writes) {
    const before = existsSync(write.destination) ? await readFile(write.destination) : new Uint8Array();
    const markdown = write.destination.endsWith(".md") || write.destination.endsWith(".toml");
    if (markdown) {
      output += unifiedDiff(new TextDecoder().decode(before), new TextDecoder().decode(write.content), write.destination);
    } else if (!Buffer.from(before).equals(Buffer.from(write.content))) {
      output += `Binary file changed: ${write.destination}\n`;
    }
  }
  for (const deletion of plan.deletes) {
    if (!existsSync(deletion.destination)) continue;
    const before = await readFile(deletion.destination);
    if (deletion.destination.endsWith(".md") || deletion.destination.endsWith(".toml")) {
      output += unifiedDiff(new TextDecoder().decode(before), "", deletion.destination);
    } else {
      output += `Binary file deleted: ${deletion.destination}\n`;
    }
  }
  if (entries !== undefined) {
    const changes = (label: string, desired: readonly string[], previous: readonly string[]) => [
      ...desired.filter((entry) => !previous.includes(entry)).map((entry) => `+ ${label}: ${entry}\n`),
      ...previous.filter((entry) => !desired.includes(entry)).map((entry) => `- ${label}: ${entry}\n`),
    ];
    output += [
      ...changes(`claudeMdExcludes in ${entries.settingsPath}`, entries.claudeMdExcludes, entries.previousClaudeMdExcludes),
      ...entries.excludes.filter((entry) => !entries.presentExcludes.includes(entry)).map((entry) => `+ ${entries.excludePath}: ${entry}\n`),
    ].join("");
  }
  process.stdout.write(output || "No changes.\n");
}

function explainHuman(plan: BuiltPlan): string {
  const explanation = plan.explanation as {
    artifacts?: Array<Record<string, unknown>>;
    profile?: { name: string; chain: string[]; packs: Array<{ pack: string; profile: string }> };
  };
  const lines = [
    `${plan.mode} plan`,
    `Config: ${plan.configPath}`,
    ...(plan.sourceRoot ? [`Source Repository: ${plan.sourceRoot}`] : []),
    ...(plan.projectRoot ? [`Project: ${plan.projectRoot}`] : []),
    ...(explanation.profile
      ? [
          `Profile: ${explanation.profile.name} (chain: ${explanation.profile.chain.join(" -> ")})`,
          ...explanation.profile.packs.map((item) => `  pack ${item.pack}: from profile ${item.profile}`),
        ]
      : []),
    "",
  ];
  for (const artifact of explanation.artifacts ?? []) {
    const label = artifact.kind === "skill" ? `skill ${artifact.name}` : "instruction layer";
    lines.push(`${artifact.harness} ${artifact.scope}: ${label}`);
    lines.push(`  destination: ${artifact.destination}`);
    if (artifact.layer) lines.push(`  layer: ${artifact.layer}`);
    if (artifact.template) lines.push(`  template: ${artifact.template}`);
    if (artifact.templateSourceId) {
      lines.push(`  template source: ${artifact.templateSourceId} (selected as ${artifact.templateSelection ?? "(unknown)"})`);
    }
    if (Array.isArray(artifact.packs)) lines.push(`  packs: ${artifact.packs.join(", ") || "(none)"}`);
    if (Array.isArray(artifact.packSources)) {
      for (const value of artifact.packSources) {
        const pack = value as { selection?: string; sourceId?: string; directory?: string };
        lines.push(`  pack ${pack.sourceId ?? "(unknown)"}: ${pack.directory ?? "(unknown)"} (selected as ${pack.selection ?? "(unknown)"})`);
      }
    }
    if (artifact.sourceId) lines.push(`  source: ${artifact.sourceId}`);
    if (typeof artifact.bytes === "number") lines.push(`  bytes: ${artifact.bytes}`);
    if (typeof artifact.markdownBytes === "number") lines.push(`  markdown bytes: ${artifact.markdownBytes}`);
    if (typeof artifact.supportBytes === "number") lines.push(`  support bytes: ${artifact.supportBytes}`);
    if (Array.isArray(artifact.enabledBy)) lines.push(`  enabled by packs: ${artifact.enabledBy.join(", ") || "(explicit)"}`);
    if (artifact.explicitlyEnabled === true) lines.push("  explicitly enabled: yes");
    if (Array.isArray(artifact.scopeExclusions) && artifact.scopeExclusions.length > 0) {
      lines.push(`  scope exclusions: ${artifact.scopeExclusions.join(", ")}`);
    }
    const trace = artifact.trace as { includes?: string[]; slots?: Record<string, string[]> } | undefined;
    if (trace?.includes?.length) lines.push(`  includes: ${trace.includes.join(", ")}`);
    for (const [slot, snippets] of Object.entries(trace?.slots ?? {})) {
      lines.push(`  slot ${slot}: ${snippets.join(", ") || "(empty)"}`);
    }
    if (Array.isArray(artifact.files)) {
      for (const value of artifact.files) {
        const file = value as { path?: string; bytes?: number; supportBytes?: number; trace?: { includes?: string[]; slots?: Record<string, string[]> } };
        lines.push(`  file: ${file.path ?? "(unknown)"}`);
        if (typeof file.bytes === "number") lines.push(`    bytes: ${file.bytes}`);
        if (typeof file.supportBytes === "number") lines.push(`    support bytes: ${file.supportBytes}`);
        if (file.trace?.includes?.length) lines.push(`    includes: ${file.trace.includes.join(", ")}`);
        for (const [slot, snippets] of Object.entries(file.trace?.slots ?? {})) {
          lines.push(`    slot ${slot}: ${snippets.join(", ") || "(empty)"}`);
        }
      }
    }
  }
  if (plan.diagnostics.length > 0) lines.push("", diagnosticsText(plan.diagnostics));
  return `${lines.join("\n")}\n`;
}

async function planFor(mode: "global" | "project", options: CommandOptions): Promise<BuiltPlan> {
  return mode === "global"
    ? buildGlobalPlan(options.config ?? MACHINE_CONFIG_PATH)
    : buildProjectPlan(options.project ?? process.cwd(), options.config ?? MACHINE_CONFIG_PATH);
}

export type CommandAction =
  | "sync"
  | "generate"
  | "diff"
  | "lint"
  | "explain"
  | "status"
  | "adopt"
  | "add"
  | "init"
  | "schedule-install"
  | "schedule-uninstall"
  | "schedule-status"
  | "clean";

const GLOBAL_ONLY_ACTIONS: ReadonlySet<CommandAction> = new Set(["status", "schedule-install", "schedule-uninstall", "schedule-status"]);

/** Execute one CLI command and return its process exit code. */
export async function executeCommand(mode: "global" | "project", action: CommandAction, options: CommandOptions): Promise<number> {
  if (action === "sync" && mode !== "global") throw new Error("Project sync is not supported");
  if (GLOBAL_ONLY_ACTIONS.has(action) && mode !== "global") throw new Error(`Project ${action} is not supported`);
  if (mode === "global" && (action === "sync" || action === "generate")) {
    await runRecordedGlobal(action, options);
    return 0;
  }
  if (action === "status") return printGlobalStatus(options);
  if (action === "add") {
    if (options.slot === undefined) throw new AgentsmithError("config", `${mode} add requires a slot`);
    await addSnippet(mode, { ...options, slot: options.slot });
    return 0;
  }
  if (action === "adopt") {
    if (options.skill !== undefined) {
      if (options.slot !== undefined) throw new AgentsmithError("config", "--slot applies to instruction adoption, not --skill");
      await adoptSkill(mode, { ...options, skill: options.skill });
      return 0;
    }
    if (mode === "project") throw new AgentsmithError("config", "project adopt requires --skill NAME");
    if (options.push || options.noCommit) throw new AgentsmithError("config", "--push and --no-commit apply only to global adopt --skill");
    await adoptGlobal(options);
    return 0;
  }
  if (action === "init" && mode === "project") {
    await projectInit({ project: options.project, prepare: options.prepare, template: options.template });
    return 0;
  }
  if (action === "init") {
    if (options.url === undefined || options.profile === undefined) throw new Error("global init requires a Git URL and --profile");
    await globalInit({ ...options, url: options.url, profile: options.profile });
    return 0;
  }
  if (action === "schedule-install") {
    await installSchedule({ interval: options.interval, config: options.config });
    return 0;
  }
  if (action === "schedule-uninstall") {
    await uninstallSchedule();
    return 0;
  }
  if (action === "schedule-status") return printScheduleStatus();
  if (action === "clean") {
    await (mode === "global" ? cleanGlobal(options) : cleanProject(options));
    return 0;
  }
  const plan = await classify("config", () => planFor(mode, options));
  if (action === "generate") {
    await generateProject(plan, { onModified: options.onModified });
  } else if (action === "diff") {
    await diffPlan(plan);
  } else if (action === "lint") {
    printDiagnostics(plan.diagnostics);
    await classify("config", () => assertPlanValid(plan, options.warningsAsErrors));
    const unmanaged = exclusiveViolations(plan, await recordedPaths(plan));
    if (unmanaged.length > 0) throw unmanagedSkillsError(mode, unmanaged);
    console.log(`Lint passed with ${plan.diagnostics.filter((item) => item.severity === "warning").length} warning(s).`);
  } else {
    await classify("config", () => assertPlanValid(plan));
    process.stdout.write(options.json ? `${JSON.stringify(plan.explanation, null, 2)}\n` : explainHuman(plan));
  }
  return 0;
}
