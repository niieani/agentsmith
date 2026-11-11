import { existsSync } from "node:fs";
import { readFile, rmdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { stringify } from "smol-toml";
import { loadMachineConfig, MACHINE_CONFIG_PATH, resolveConfiguredPath } from "./config.ts";
import { adoptGlobal } from "./adopt.ts";
import { classify, errorCode, errorMessage, exitCodeFor } from "./errors.ts";
import { CommandError, ensureCleanSource, gitHeadCommit, gitPullFfOnly, gitWorktree } from "./git.ts";
import { assertPlanValid, buildGlobalPlan, buildProjectPlan, type BuiltPlan } from "./planner.ts";
import {
  applyPlan,
  backupGlobalArtifacts,
  collectBlobs,
  globalBlobDirectory,
  globalStatePath,
  hashBytes,
  loadGlobalState,
  loadProjectState,
  preflightGlobalPlan,
  preflightProjectPlan,
  projectStatePath,
  restoreBackups,
  storeBlobs,
  unifiedDiff,
  type ArtifactBackup,
  type GlobalState,
  type ProjectState,
} from "./safety.ts";
import { printGlobalStatus, writeGlobalStatus, type RunReport } from "./status.ts";
import type { Diagnostic, GenerationPlan, PlannedDelete, PlannedWrite } from "./types.ts";

const encoder = new TextEncoder();

export interface CommandOptions {
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

async function prepareGlobalPlan(plan: BuiltPlan): Promise<{
  statePath: string;
  previous: GlobalState;
}> {
  const statePath = globalStatePath();
  const previous = await loadGlobalState(statePath);
  const current = new Set(plan.plannedPaths.map((path) => resolve(path)));
  plan.deletes = Object.keys(previous.artifacts)
    .filter((path) => !current.has(resolve(path)))
    .map((path): PlannedDelete => ({ destination: path, kind: "skill" }));
  return { statePath, previous };
}

function projectStateWrite(statePath: string, root: string, plan: BuiltPlan): PlannedWrite {
  const state = {
    version: 1,
    paths: [...new Set(plan.plannedPaths.map((path) => relativeStatePath(root, path)))].sort(),
  };
  return {
    destination: statePath,
    content: encoder.encode(stringify(state)),
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
    const markers = [`${sep}.agents${sep}skills${sep}`, `${sep}.claude${sep}skills${sep}`];
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

async function generateProject(plan: BuiltPlan): Promise<void> {
  await classify("config", () => assertPlanValid(plan));
  printDiagnostics(plan.diagnostics.filter((item) => item.severity === "warning"));
  const prepared = await prepareProjectPlan(plan);
  await preflightProjectPlan(plan, { projectRoot: plan.projectRoot!, state: prepared.previous });
  const application: GenerationPlan = {
    ...plan,
    writes: [...plan.writes, projectStateWrite(prepared.statePath, prepared.worktree.root, plan)],
  };
  await applyPlan(application);
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
  const blobs = globalBlobDirectory(prepared.statePath);
  await storeBlobs(
    blobs,
    plan.writes.map((write) => write.content),
  );
  const backups: ArtifactBackup[] = await backupGlobalArtifacts(conflicts, { plan, state: prepared.previous });
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
    warn(report, `WARNING artifact-backup: moved ${backup.reason} global artifact ${backup.path} to ${backup.backup}`);
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
async function runRecordedGlobal(action: "sync" | "generate", options: CommandOptions): Promise<void> {
  const startedAt = new Date();
  const report: RunReport = { warnings: [], backups: [] };
  let failure: unknown;
  try {
    const configPath = resolveConfiguredPath(options.config ?? MACHINE_CONFIG_PATH, resolve(process.cwd(), "config.toml"));
    const machine = await classify("config", () => loadMachineConfig(configPath));
    report.profile = machine.profile;
    if (action === "sync") {
      await ensureCleanSource(machine.source);
      await gitPullFfOnly(machine.source);
    }
    report.sourceCommit = await gitHeadCommit(machine.source);
    const plan = await classify("config", () => buildGlobalPlan(options.config ?? MACHINE_CONFIG_PATH));
    await generateGlobal(plan, { force: options.force, onModified: options.onModified }, report);
  } catch (cause) {
    failure = cause;
  }
  try {
    await writeGlobalStatus({
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
    });
  } catch (cause) {
    console.error(`WARNING status-write: could not record run status: ${errorMessage(cause)}`);
  }
  if (failure !== undefined) throw failure;
}

async function diffPlan(plan: BuiltPlan): Promise<void> {
  if (plan.mode === "project") {
    try {
      await prepareProjectPlan(plan);
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

export type CommandAction = "sync" | "generate" | "diff" | "lint" | "explain" | "status" | "adopt";

/** Execute one CLI command and return its process exit code. */
export async function executeCommand(mode: "global" | "project", action: CommandAction, options: CommandOptions): Promise<number> {
  if (action === "sync" && mode !== "global") throw new Error("Project sync is not supported");
  if ((action === "status" || action === "adopt") && mode !== "global") throw new Error(`Project ${action} is not supported`);
  if (mode === "global" && (action === "sync" || action === "generate")) {
    await runRecordedGlobal(action, options);
    return 0;
  }
  if (action === "status") return printGlobalStatus(options);
  if (action === "adopt") {
    await adoptGlobal(options);
    return 0;
  }
  const plan = await classify("config", () => planFor(mode, options));
  if (action === "generate") {
    await generateProject(plan);
  } else if (action === "diff") {
    await diffPlan(plan);
  } else if (action === "lint") {
    printDiagnostics(plan.diagnostics);
    await classify("config", () => assertPlanValid(plan, options.warningsAsErrors));
    console.log(`Lint passed with ${plan.diagnostics.filter((item) => item.severity === "warning").length} warning(s).`);
  } else {
    await classify("config", () => assertPlanValid(plan));
    process.stdout.write(options.json ? `${JSON.stringify(plan.explanation, null, 2)}\n` : explainHuman(plan));
  }
  return 0;
}
